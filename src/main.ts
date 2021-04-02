import * as utils from '@iobroker/adapter-core';
import firebase from 'firebase-admin';
import { Device, FirestoreDevice, FirestoreRoom, Room, UsedConfig } from './lib/adapter-config';

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

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

    process.nextTick(() => {
        deleteQueryBatch(db, query, resolve);
    });
}

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
        const { serviceAccount, jsonOverwrite } = this.config;

        if (!serviceAccount) {
            this.log.error('No service account set, exiting...');
            throw new Error('No service account provided');
        }

        try {
            firebase.initializeApp({
                credential: firebase.credential.cert(serviceAccount),
            });
        } catch (e) {
            this.log.error('Failed to initialize firebase');
            this.log.error(e?.message || e);
        }

        const firestore = firebase.firestore();
        this.#firestore = firestore;

        let builtConfig: Partial<UsedConfig> = {};
        const overwrite = !!jsonOverwrite;

        const targetTypeRef = firestore.collection('devices').doc('definitions').collection('targetTypes');
        const sourceTypeRef = firestore.collection('devices').doc('definitions').collection('sourceTypes');

        if (jsonOverwrite) {
            builtConfig = jsonOverwrite;

            await deleteCollection(firestore, 'devices');
            await deleteCollection(firestore, 'states');
            await deleteCollection(firestore, 'rooms');

            const { sourceTypes, targetTypes } = jsonOverwrite;

            for (const [name, sourceType] of Object.entries(sourceTypes)) {
                try {
                    await sourceTypeRef.doc(name).set(sourceType);
                } catch (e) {
                    this.log.error(`Failed to add doc with name "${name}"`);
                    this.log.error(e?.message || e);
                    this.stop?.call(this);
                    return;
                }
            }

            for (const [name, targetType] of Object.entries(targetTypes)) {
                try {
                    await targetTypeRef.doc(name).set({ entries: targetType });
                } catch (e) {
                    this.log.error(`Failed to add doc with name "${name}"`);
                    this.log.error(e?.message || e);
                    return;
                }
            }
        } else {
            const rooms: Room[] = (await firestore.collection('rooms').get()).docs.map(
                (doc) => (doc.data() as FirestoreRoom).name,
            );
            const devices: Device[] = (await firestore.collection('rooms').get()).docs.map((doc) => {
                const { name, roomName, sourceType, externalStates, path } = doc.data() as FirestoreDevice;

                return { name, roomName, sourceType, externalStates, path };
            });

            const targetTypes: {
                [key: string]: { name: string; optional?: boolean; external?: boolean; virtual?: boolean }[];
            } = {};
            for (const doc of (await targetTypeRef.get()).docs) {
                targetTypes[doc.id] = doc.data().entries as {
                    name: string;
                    optional?: boolean;
                    external?: boolean;
                    virtual?: boolean;
                }[];
            }

            const sourceTypes: {
                [key: string]: {
                    targetType: string;
                    values: {
                        targetValueName: string;
                        sourceValueName: string;
                    }[];
                };
            } = {};
            for (const doc of (await sourceTypeRef.get()).docs) {
                sourceTypes[doc.id] = doc.data() as {
                    targetType: string;
                    values: {
                        targetValueName: string;
                        sourceValueName: string;
                    }[];
                };
            }

            builtConfig.devices = devices;
            builtConfig.rooms = rooms;
            builtConfig.sourceTypes = sourceTypes;
            builtConfig.targetTypes = targetTypes;

            this.log.info(JSON.stringify(targetTypes));
            this.log.info(JSON.stringify(sourceTypes));
        }

        const usedConfig = builtConfig as UsedConfig;
        const { rooms, devices, sourceTypes, targetTypes } = usedConfig;

        if (jsonOverwrite) {
            for (const room of rooms) {
                try {
                    await firestore.collection('rooms').add({ name: room });
                } catch {
                    this.log.error('Failed to add room to firestore:');
                    this.log.error(JSON.stringify(room));
                }
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

            const targetValues = Object.entries(targetTypes).find(([key]) => key === deviceTargetType)?.[1];

            this.log.info(JSON.stringify(targetValues));

            if (!targetValues) {
                continue;
            }

            const targetDeviceBasePath = `states.${deviceRoomName}.${deviceTargetType}.${deviceName}`;

            if (overwrite) {
                const deviceDocData: FirestoreDevice = {
                    name: deviceName,
                    roomName: deviceRoomName,
                    type: deviceTargetType,
                    sourceType: deviceSourceType,
                    path: devicePath,
                    ...(externalStates ? { externalStates } : {}),
                };

                try {
                    await firestore.collection('devices').add(deviceDocData);
                } catch {
                    this.log.error('Failed to add device to firestore:');
                    this.log.error(JSON.stringify(deviceDocData));
                }
            }

            for (const targetValueEntry of targetValues) {
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
                    this.log.info('Skip');
                    this.log.info(JSON.stringify(targetValueEntry));
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

                if (overwrite) {
                    const stateDocData = {
                        deviceName,
                        roomName: deviceRoomName,
                        name: targetValueName,
                        value: actualValue,
                        timestamp: Date.now(),
                        deviceType: deviceTargetType,
                    };
                    try {
                        await firestore.collection('states').add(stateDocData);
                    } catch {
                        this.log.error('Failed to add state to firestore:');
                        this.log.error(JSON.stringify(stateDocData));
                    }
                }
            }
        }

        if (overwrite) {
            this.updateConfig({
                jsonOverwrite: undefined,
                usedConfig,
            });

            return;
        }

        firestore?.collection('states').onSnapshot((snap) => {
            snap.docChanges().forEach(async (change) => {
                const { deviceName, roomName, name, value, deviceType } = change.doc.data();
                const statePath = `states.${roomName}.${deviceType}.${deviceName}.${name}.value`;

                const oldState = (await this.getStateAsync(statePath))?.val;

                if (oldState == value) return;

                await this.setStateAsync(statePath, { val: value, ack: false });
            });
        });

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
        if (!this.config.usedConfig) return;
        if (!state) return;

        const isForeign = !id.includes('smart-connect-firestore-sync');

        // Ignore already synced state changes
        if (!isForeign && state.ack) {
            return;
        }

        if (isForeign) {
            const externalDevice = this.config.usedConfig.devices.find(
                ({ externalStates }) =>
                    externalStates && Object.values(externalStates).find((externalPath) => id.includes(externalPath)),
            );
            const defaultDevice = this.config.usedConfig.devices.find(({ path }) => path && id.includes(path));

            const device = defaultDevice || externalDevice;

            if (!device) {
                return;
            }

            let targetPath: string | undefined = undefined;
            let targetValue: string | undefined = undefined;

            const sourceTypeDevice = this.config.usedConfig.sourceTypes[device.sourceType];

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

            if (this.#firestore) {
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
                        try {
                            await docRef.update({ value: state.val ?? null, timestamp: new Date().toUTCString() });
                        } catch {
                            this.log.error('Failed to update state in firestore:');
                            this.log.error(
                                JSON.stringify({ value: state.val ?? null, timestamp: new Date().toUTCString() }),
                            );
                        }
                    }
                }
            }
        } else {
            const [, , , roomName, targetDeviceType, deviceName, valueName, valueProperty] = id.split('.');
            if (valueProperty !== 'value') return;
            try {
                const device = this.config.usedConfig.devices.find(
                    ({ roomName: deviceRoomName, name }) => deviceRoomName === roomName && name === deviceName,
                );

                if (!device) {
                    return;
                }

                if (!device.path) {
                    return;
                }

                const { sourceType, path: sourceDeviceBasePath } = device;

                const targetValueDefinition = this.config.usedConfig.targetTypes[targetDeviceType].find(
                    ({ name }) => valueName === name,
                );

                if (!targetValueDefinition) {
                    return;
                }

                const isExternal = !!targetValueDefinition.external;

                const sourceDeviceType = this.config.usedConfig.sourceTypes[sourceType];

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
