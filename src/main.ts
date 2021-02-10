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

class SmartConnectFirestoreSync extends utils.Adapter {
    #lastCurrentValues = new Map<string, any>();
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
        try {
            if (serviceAccount) {
                firebase.initializeApp({
                    credential: firebase.credential.cert(serviceAccount),
                    databaseURL: 'https://kosimst-smart-home.firebaseio.com',
                });
                firebaseInit = true;
            }
        } catch (e) {
            this.log.error(`Failed to initialize firebase: ${e}`);
        }

        if (firebaseInit) {
            this.log.info('Firebase active');
            firestore = firebase.firestore();
            this.#firestore = firestore;
            await deleteCollection(firestore, 'devices');
            await deleteCollection(firestore, 'states');
            await deleteCollection(firestore, 'rooms');

            for (const room of rooms) {
                await firestore.collection('rooms').add({ name: room });
            }
        } else {
            this.log.warn('Firebase not active');
        }

        this.log.info(`Adapter ${this.name} ready`);

        const oldStates = await this.getStatesAsync('states.*');

        for (const [path] of Object.entries(oldStates || {})) {
            const usedPath = path.split('0.')[1];
            // TODO: Check if state should be kept
            this.log.info(`Deleting state ${usedPath}...`);
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
                this.log.warn(`Failed to set up device ${deviceName} as no source device definition could be found`);
                continue;
            }

            const { targetType: deviceTargetType, values: sourceValues } = deviceSourceObject;

            this.log.info(`Device is typeof "${deviceTargetType}" (${deviceSourceType})`);

            const targeValues = Object.entries(this.config.targetTypes).find(([key]) => key === deviceTargetType)?.[1];

            if (!targeValues) {
                this.log.warn(`Failed to set up device ${deviceName} as no target device values could be found`);
                continue;
            }

            const targetDeviceBasePath = `states.${deviceRoomName}.${deviceTargetType}.${deviceName}`;

            this.log.info(`Setting up "${deviceName}" in "${deviceRoomName}"...`);

            if (firestore) {
                await firestore
                    .collection('devices')
                    .add({ name: deviceName, roomName: deviceRoomName, type: deviceTargetType });
            }

            for (const targetValueEntry of targeValues) {
                const { name: targetValueName, external = false, optional = false, virtual = false } = targetValueEntry;
                // Create states in adapter
                const valueBasePath = `${targetDeviceBasePath}.${targetValueName}`;

                this.log.info(`Creating "${targetValueName}" value...`);

                const sourceValue = sourceValues.find(({ targetValueName: target }) => targetValueName === target)
                    ?.sourceValueName;
                if (!sourceValue && !optional && !virtual) {
                    this.log.error(
                        `Could not find value mapping for ${deviceName} (${targetValueName}->${sourceValue})`,
                    );
                    throw new Error('Failed to create states');
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
                await this.setObjectNotExistsAsync(`${valueBasePath}.previous`, {
                    type: 'state',
                    common: {
                        name: 'Previous value',
                        type: 'mixed',
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
                    if (external && (!externalStates || !externalStates[targetValueName])) {
                        this.log.error('Could not find external state mapping');
                        continue;
                    }
                    if (!sourceValue) {
                        this.log.error(
                            `Could not find matching source device value for "${targetValueName}" (${deviceName})`,
                        );
                        continue;
                    }
                    sourceValuePath = external ? externalStates![targetValueName] : `${devicePath}.${sourceValue}`;
                    actualValue = (await this.getForeignStateAsync(sourceValuePath))?.val ?? null;
                    this.#lastCurrentValues.set(sourceValuePath, actualValue);
                    await this.subscribeForeignStatesAsync(sourceValuePath);
                }

                this.log.info(`Created "${targetValueName}" with value ${actualValue}`);

                await this.setStateAsync(`${valueBasePath}.value`, { val: actualValue, ack: true });
                await this.setStateAsync(`${valueBasePath}.previous`, null);
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

        firestore?.collection('states').onSnapshot((snap) => {
            snap.docChanges().forEach((change) => {
                const { deviceName, roomName, name, value, deviceType } = change.doc.data();
                const statePath = `states.${roomName}.${deviceType}.${deviceName}.${name}`;

                this.log.info(`Firestore value "${name}" from ${deviceName} changed to ${value}`);

                this.setStateAsync(statePath, { val: value, ack: false, c: 'firestore-update' });
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

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state) return;

        this.log.info(`State "${id}" changed by ${state.from}`);
        this.log.info(`Full state: ${JSON.stringify(state)}`);

        const isSelfModified = state.from.includes('smart-connect-firestore-sync');
        if (isSelfModified && state.ack) {
            return;
        }

        const isForeign = !id.includes('smart-connect-firestore-sync');

        if (isForeign) {
            const devicePath = this.config.devices.find(({ path }) => path && id.includes(path))?.path;
            if (!devicePath) {
                this.log.warn('No device matches the changed path');
                return;
            }
            this.log.info(`Device path: ${devicePath}`);
            const device = this.config.devices.find(({ path }) => path === devicePath);
            if (!device) {
                this.log.warn(`No device found for state change`);
                return;
            }
            const sourceValue = id.replace(devicePath, '').replace(/^\./, '');
            const sourceTypeDevice = this.config.sourceTypes[device.sourceType];
            if (!sourceTypeDevice) {
                this.log.warn(`No source device declaration found for state change`);
                return;
            }
            const targetValue =
                sourceTypeDevice.values.find(({ sourceValueName }) => sourceValueName === sourceValue)
                    ?.targetValueName || sourceValue;
            if (!targetValue) {
                this.log.warn(`No target value mapping found for state change`);
                return;
            }
            const targetPath = `states.${device.roomName}.${sourceTypeDevice.targetType}.${device.name}.${targetValue}`;

            const previousValue = (await this.getStateAsync(`${targetPath}.value`))?.val;

            await this.setStateAsync(`${targetPath}.value`, { val: state.val ?? null, ack: true });
            await this.setStateAsync(`${targetPath}.previous`, { val: previousValue ?? null, ack: true });
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
                    doc.docs[0].ref.update({ value: state.val ?? null, timestamp: new Date().toUTCString() });
                } else {
                    this.log.warn(
                        `Could not find firestore value for ${device.name} in ${device.roomName} (${targetValue} of ${sourceTypeDevice.targetType})`,
                    );
                }
            }
        } else {
            const [, , , roomName, targetDeviceType, deviceName, valueName, valueProperty] = id.split('.');
            const devicePath = `states.${roomName}.${targetDeviceType}.${deviceName}.${valueName}`;
            if (valueProperty !== 'value') return;
            try {
                const device = this.config.devices.find(
                    ({ roomName: deviceRoomName, name }) => deviceRoomName === roomName && name === deviceName,
                );

                if (!device) {
                    this.log.error('No device found to changed state');
                    return;
                }

                if (!device.path) {
                    this.log.warn('No device path found to changed state');
                    return;
                }

                const { sourceType, path: sourceDeviceBasePath } = device;

                const sourceDeviceType = this.config.sourceTypes[sourceType];

                if (!sourceDeviceType) {
                    this.log.error('No source device type found for state change');
                    return;
                }

                const sourceDeviceValue =
                    sourceDeviceType.values.find(({ targetValueName }) => targetValueName === valueName)
                        ?.sourceValueName || valueName;

                if (!sourceDeviceValue) {
                    this.log.error('No value mapping found for state change');
                    return;
                }

                const sourceDevicePath = `${sourceDeviceBasePath}.${sourceDeviceValue}`;

                await this.setForeignStateAsync(sourceDevicePath, { val: state.val ?? null });
                await this.setStateAsync(`${devicePath}.timestamp`, { ack: true, val: new Date().toUTCString() });
                await this.setStateAsync(`${devicePath}.previous`, {
                    val: this.#lastCurrentValues.get(sourceDevicePath) ?? null,
                    ack: true,
                });
                this.#lastCurrentValues.set(sourceDevicePath, state.val ?? null);
                await this.setStateAsync(`${devicePath}.value`, { val: state.val ?? null, ack: true });
            } catch (e) {
                this.log.warn(e.message);

                const prevValue = (await this.getStateAsync(`${devicePath}.previous`))?.val;
                await this.setStateAsync(`${devicePath}.value`, { ack: true, val: prevValue ?? null });
            }
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  */
    // private onMessage(obj: ioBroker.Message): void {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }
}

if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SmartConnectFirestoreSync(options);
} else {
    // otherwise start the instance directly
    (() => new SmartConnectFirestoreSync())();
}
