"use strict";
/*
 * Created with @iobroker/create-adapter v1.31.0
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, privateMap, value) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to set private field on non-instance");
    }
    privateMap.set(receiver, value);
    return value;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _firestore;
Object.defineProperty(exports, "__esModule", { value: true });
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = __importStar(require("@iobroker/adapter-core"));
const firebase_admin_1 = __importDefault(require("firebase-admin"));
// Load your modules here, e.g.:
// import * as fs from "fs";
async function deleteCollection(db, collectionPath, batchSize = 16) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);
    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, resolve).catch(reject);
    });
}
async function deleteQueryBatch(db, query, resolve) {
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
const generateDeviceDocumentId = ({ name, roomName, sourceType, }) => `${name}_${roomName}_${sourceType}`;
class SmartConnectFirestoreSync extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'smart-connect-firestore-sync',
        });
        _firestore.set(this, null);
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        var _a, _b, _c, _d;
        const { devices, sourceTypes, serviceAccount, rooms } = this.config;
        let firebaseInit = false;
        let firestore = null;
        if (serviceAccount) {
            try {
                firebase_admin_1.default.initializeApp({
                    credential: firebase_admin_1.default.credential.cert(serviceAccount),
                    databaseURL: 'https://kosimst-smart-home.firebaseio.com',
                });
                firebaseInit = true;
            }
            catch (_e) { }
        }
        if (firebaseInit) {
            firestore = firebase_admin_1.default.firestore();
            __classPrivateFieldSet(this, _firestore, firestore);
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
        for (const { name: deviceName, roomName: deviceRoomName, sourceType: deviceSourceType, path: devicePath, externalStates, } of devices) {
            const deviceSourceObject = sourceTypes[deviceSourceType];
            if (!deviceSourceObject) {
                continue;
            }
            const { targetType: deviceTargetType, values: sourceValues } = deviceSourceObject;
            const targeValues = (_a = Object.entries(this.config.targetTypes).find(([key]) => key === deviceTargetType)) === null || _a === void 0 ? void 0 : _a[1];
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
                const sourceValue = (_b = sourceValues.find(({ targetValueName: target }) => targetValueName === target)) === null || _b === void 0 ? void 0 : _b.sourceValueName;
                if (!sourceValue && !optional && !virtual) {
                    throw new Error('Failed to create states');
                }
                if (!virtual &&
                    ((!sourceValue && !external) || (external && (!externalStates || !externalStates[targetValueName])))) {
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
                    sourceValuePath = external ? externalStates[targetValueName] : `${devicePath}.${sourceValue}`;
                    actualValue = (_d = (_c = (await this.getForeignStateAsync(sourceValuePath))) === null || _c === void 0 ? void 0 : _c.val) !== null && _d !== void 0 ? _d : null;
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
    onUnload(callback) {
        try {
        }
        catch (e) {
        }
        finally {
            callback();
        }
    }
    /**
     * Is called if a subscribed state changes
     */
    async onStateChange(id, state) {
        var _a, _b, _c, _d, _e, _f;
        if (!state)
            return;
        const isForeign = !id.includes('smart-connect-firestore-sync');
        // Ignore already synced state changes
        if (!isForeign && state.ack) {
            return;
        }
        if (isForeign) {
            const externalDevice = this.config.devices.find(({ externalStates }) => externalStates && Object.values(externalStates).find((externalPath) => id.includes(externalPath)));
            const defaultDevice = this.config.devices.find(({ path }) => path && id.includes(path));
            const device = defaultDevice || externalDevice;
            if (!device) {
                return;
            }
            let targetPath = undefined;
            let targetValue = undefined;
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
                    ((_a = sourceTypeDevice.values.find(({ sourceValueName }) => sourceValueName === sourceValue)) === null || _a === void 0 ? void 0 : _a.targetValueName) || sourceValue;
                if (!targetValue) {
                    return;
                }
                targetPath = `states.${device.roomName}.${sourceTypeDevice.targetType}.${device.name}.${targetValue}`;
            }
            else {
                targetValue = (_b = Object.entries(device.externalStates).find(([, externalPath]) => id.includes(externalPath))) === null || _b === void 0 ? void 0 : _b[0];
                if (!targetValue) {
                    return;
                }
                targetPath = `states.${device.roomName}.${sourceTypeDevice.targetType}.${device.name}.${targetValue}`;
            }
            await this.setStateAsync(`${targetPath}.value`, { val: (_c = state.val) !== null && _c !== void 0 ? _c : null, ack: true });
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
        }
        else {
            const [, , , roomName, targetDeviceType, deviceName, valueName, valueProperty] = id.split('.');
            if (valueProperty !== 'value')
                return;
            try {
                const device = this.config.devices.find(({ roomName: deviceRoomName, name }) => deviceRoomName === roomName && name === deviceName);
                if (!device) {
                    return;
                }
                if (!device.path) {
                    return;
                }
                const { sourceType, path: sourceDeviceBasePath } = device;
                const targetValueDefinition = this.config.targetTypes[targetDeviceType].find(({ name }) => valueName === name);
                if (!targetValueDefinition) {
                    return;
                }
                const isExternal = !!targetValueDefinition.external;
                const sourceDeviceType = this.config.sourceTypes[sourceType];
                if (!sourceDeviceType) {
                    return;
                }
                const sourceDeviceValue = ((_d = sourceDeviceType.values.find(({ targetValueName }) => targetValueName === valueName)) === null || _d === void 0 ? void 0 : _d.sourceValueName) || valueName;
                if (!sourceDeviceValue) {
                    return;
                }
                const sourceDevicePath = isExternal
                    ? ((_e = Object.entries(device.externalStates).find(([key]) => key === valueName)) === null || _e === void 0 ? void 0 : _e[1]) || ''
                    : `${sourceDeviceBasePath}.${sourceDeviceValue}`;
                await this.setForeignStateAsync(sourceDevicePath, { val: (_f = state.val) !== null && _f !== void 0 ? _f : null });
            }
            catch (_g) { }
        }
    }
}
_firestore = new WeakMap();
if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options) => new SmartConnectFirestoreSync(options);
}
else {
    // otherwise start the instance directly
    (() => new SmartConnectFirestoreSync())();
}
