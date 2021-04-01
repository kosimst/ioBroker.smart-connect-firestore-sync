/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';
import firebase from 'firebase-admin';

// Load your modules here, e.g.:
// import * as fs from "fs";

async function deleteCollection(
    db: firebase.firestore.Firestore,
    collectionPath: string,
    batchSize = 16,
): Promise<void> {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(
    db: firebase.firestore.Firestore,
    query: firebase.firestore.Query,
    resolve: (...args: any[]) => any,
): Promise<void> {
    const snapshot = await query.get();

    const batchSize = snapshot.size;
    if (batchSize === 0) {
        // When there are no documents left, we are done
        resolve();
        return;
    }

    // Delete documents in a batch
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

    // Recurse on the next process tick, to avoid
    // exploding the stack.
    process.nextTick(() => {
        deleteQueryBatch(db, query, resolve);
    });
}

const generateDeviceDocumentId = ({
    name,
    roomName,
    sourceType,
}: {
    name: string;
    path?: string;
    roomName: string;
    sourceType: string;
    externalStates?: { [key: string]: string };
}): string => `${name}_${roomName}_${sourceType}`;

class SmartConnectFirestoreSync extends utils.Adapter {
    #firestore: firebase.firestore.Firestore | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'smart-connect-firestore-sync',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        const { devices, sourceTypes, serviceAccount, rooms } = this.config;

        let firebaseInit = false;
        let firestore: firebase.firestore.Firestore | null = null;

        if (serviceAccount) {
            try {
                firebase.initializeApp({
                    credential: firebase.credential.cert(serviceAccount),
                    databaseURL: 'https://kosimst-smart-home.firebaseio.com',
                });
                firebaseInit = true;
            } catch {}
        }

        if (firebaseInit) {
            firestore = firebase.firestore();
            this.#firestore = firestore;

            await deleteCollection(firestore, 'devices');
            await deleteCollection(firestore, 'states');
            await deleteCollection(firestore, 'rooms');

            for (const room of rooms) {
                await firestore.collection('rooms').add(room);
            }
        }

        const oldStates = await this.getStatesAsync('states.*');

        for (const [path] of Object.entries(oldStates || {})) {
            const usedPath = path.split('0.')[1];
            await this.delObjectAsync(usedPath);
        }

        for (const {
            name: deviceName,
            roomName: deviceRoomName,
            sourceType: deviceSourceType,
            path: devicePath,
            externalStates,
        } of devices) {
            const deviceSourceObject = sourceTypes[deviceSourceType];

            if (!deviceSourceObject) {
                continue;
            }

            const { targetType: deviceTargetType, values: sourceValues } = deviceSourceObject;

            const targeValues = Object.entries(this.config.targetTypes).find(([key]) => key === deviceTargetType)?.[1];

            if (!targeValues) {
                continue;
            }

            const targetDeviceBasePath = `states.${deviceRoomName}.${deviceTargetType}.${deviceName}`;

            if (firestore) {
                await firestore
                    .collection('devices')
                    .add({ name: deviceName, roomName: deviceRoomName, type: deviceTargetType });
            }

            for (const targetValueEntry of targeValues) {
                const { name: targetValueName, external = false, optional = false, virtual = false } = targetValueEntry;
                // Create states in adapter
                const valueBasePath = `${targetDeviceBasePath}.${targetValueName}`;

                const sourceValue = sourceValues.find(({ targetValueName: target }) => targetValueName === target)
                    ?.sourceValueName;
                if (!sourceValue && !optional && !virtual) {
                    throw new Error('Failed to create states');
                }

                if (
                    !virtual &&
                    ((!sourceValue && !external) || (external && (!externalStates || !externalStates[targetValueName])))
                ) {
                    continue;
                }

                await this.setObjectNotExistsAsync(`${valueBasePath}.value`, {
                    type: 'state',
                    common: {
                        name: 'Value',
                        type: 'mixed',
                        read: true,
                        write: true,
                        // TODO: Add more specific roles
                        role: 'state',
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${valueBasePath}.timestamp`, {
                    type: 'state',
                    common: {
                        name: 'Timestamp of last change',
                        type: 'number',
                        read: true,
                        write: false,
                        // TODO: Add more specific roles
                        role: 'state',
                    },
                    native: {},
                });

                let actualValue = null;
                let sourceValuePath = '';

                if (devicePath && !virtual) {
                    sourceValuePath = external ? externalStates![targetValueName] : `${devicePath}.${sourceValue}`;
                    actualValue = (await this.getForeignStateAsync(sourceValuePath))?.val ?? null;
                    await this.subscribeForeignStatesAsync(sourceValuePath);
                }

                await this.setStateAsync(`${valueBasePath}.value`, { val: actualValue, ack: true });
                await this.setStateAsync(`${valueBasePath}.timestamp`, { val: new Date().toUTCString(), ack: true });

                if (firestore) {
                    await firestore.collection('states').add({
                        deviceName,
                        roomName: deviceRoomName,
                        name: targetValueName,
                        value: actualValue,
                        timestamp: Date.now(),
                        deviceType: deviceTargetType,
                    });
                }
            }
        }

        /*firestore?.collection('states').onSnapshot((snap) => {
            snap.docChanges().forEach(async (change) => {
                const { deviceName, roomName, name, value, deviceType } = change.doc.data();
                const statePath = `states.${roomName}.${deviceType}.${deviceName}.${name}.value`;

                this.log.info(`Firestore value "${name}" from ${deviceName} changed to ${value}`);

                const oldState = (await this.getStateAsync(statePath))?.val;

                if (oldState == value) return;

                await this.setStateAsync(statePath, { val: value, ack: false, c: 'firestore-update' });
            });
        });*/

        await this.subscribeStatesAsync('states.*');
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
        try {
        } catch (e) {
        } finally {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state) return;

        const isForeign = !id.includes('smart-connect-firestore-sync');

        // Ignore already synced state changes
        if (!isForeign && state.ack) {
            return;
        }

        if (isForeign) {
            const externalDevice = this.config.devices.find(
                ({ externalStates }) =>
                    externalStates && Object.values(externalStates).find((externalPath) => id.includes(externalPath)),
            );
            const defaultDevice = this.config.devices.find(({ path }) => path && id.includes(path));

            const device = defaultDevice || externalDevice;

            if (!device) {
                return;
            }

            let targetPath: string | undefined = undefined;
            let targetValue: string | undefined = undefined;

            const sourceTypeDevice = this.config.sourceTypes[device.sourceType];

            if (defaultDevice) {
                if (!device.path) {
                    return;
                }
                const sourceValue = id.replace(device.path, '').replace(/^\./, '');
                if (!sourceTypeDevice) {
                    return;
                }
                targetValue =
                    sourceTypeDevice.values.find(({ sourceValueName }) => sourceValueName === sourceValue)
                        ?.targetValueName || sourceValue;
                if (!targetValue) {
                    return;
                }
                targetPath = `states.${device.roomName}.${sourceTypeDevice.targetType}.${device.name}.${targetValue}`;
            } else {
                targetValue = Object.entries(device.externalStates!).find(([, externalPath]) =>
                    id.includes(externalPath),
                )?.[0];
                if (!targetValue) {
                    return;
                }
                targetPath = `states.${device.roomName}.${sourceTypeDevice.targetType}.${device.name}.${targetValue}`;
            }

            await this.setStateAsync(`${targetPath}.value`, { val: state.val ?? null, ack: true });
            await this.setStateAsync(`${targetPath}.timestamp`, { val: new Date().toUTCString(), ack: true });

            /*if (this.#firestore) {
                const doc = await this.#firestore
                    .collection('states')
                    .where('deviceName', '==', device.name)
                    .where('roomName', '==', device.roomName)
                    .where('name', '==', targetValue)
                    .where('deviceType', '==', sourceTypeDevice.targetType)
                    .limit(1)
                    .get();

                if (doc.docs.length && doc.docs[0].exists) {
                    const docRef = doc.docs[0].ref;
                    const oldValue = (await docRef.get()).data()?.value;

                    if (oldValue != state.val ?? null) {
                        docRef.update({ value: state.val ?? null, timestamp: new Date().toUTCString() });
                    }
                } else {
                    this.log.warn(
                        `Could not find firestore value for ${device.name} in ${device.roomName} (${targetValue} of ${sourceTypeDevice.targetType})`,
                    );
                }
            }*/
        } else {
            const [, , , roomName, targetDeviceType, deviceName, valueName, valueProperty] = id.split('.');
            if (valueProperty !== 'value') return;
            try {
                const device = this.config.devices.find(
                    ({ roomName: deviceRoomName, name }) => deviceRoomName === roomName && name === deviceName,
                );

                if (!device) {
                    return;
                }

                if (!device.path) {
                    return;
                }

                const { sourceType, path: sourceDeviceBasePath } = device;

                const targetValueDefinition = this.config.targetTypes[targetDeviceType].find(
                    ({ name }) => valueName === name,
                );

                if (!targetValueDefinition) {
                    return;
                }

                const isExternal = !!targetValueDefinition.external;

                const sourceDeviceType = this.config.sourceTypes[sourceType];

                if (!sourceDeviceType) {
                    return;
                }

                const sourceDeviceValue =
                    sourceDeviceType.values.find(({ targetValueName }) => targetValueName === valueName)
                        ?.sourceValueName || valueName;

                if (!sourceDeviceValue) {
                    return;
                }

                const sourceDevicePath = isExternal
                    ? Object.entries(device.externalStates!).find(([key]) => key === valueName)?.[1] || ''
                    : `${sourceDeviceBasePath}.${sourceDeviceValue}`;

                await this.setForeignStateAsync(sourceDevicePath, { val: state.val ?? null });
            } catch {}
        }
    }
}

if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SmartConnectFirestoreSync(options);
} else {
    // otherwise start the instance directly
    (() => new SmartConnectFirestoreSync())();
}
