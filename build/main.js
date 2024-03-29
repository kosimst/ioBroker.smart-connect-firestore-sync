"use strict";
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
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, privateMap) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to get private field on non-instance");
    }
    return privateMap.get(receiver);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _firestore, _usedConfig;
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const getStatePath = (roomName, deviceType, deviceName, valueName) => `${roomName}_${deviceType}_${deviceName}_${valueName}`;
async function deleteCollection(firestore, collectionPath, batchSize = 25) {
    const collectionRef = firestore.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);
    return new Promise((resolve, reject) => {
        deleteQueryBatch(firestore, query, resolve).catch(reject);
    });
}
async function deleteQueryBatch(firestore, query, resolve) {
    const snapshot = await query.get();
    const batchSize = snapshot.size;
    if (batchSize === 0) {
        // When there are no documents left, we are done
        resolve();
        return;
    }
    // Delete documents in a batch
    const batch = firestore.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    // Recurse on the next process tick, to avoid
    // exploding the stack.
    process.nextTick(() => {
        deleteQueryBatch(firestore, query, resolve);
    });
}
class SmartConnectFirestoreSync extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'smart-connect-firestore-sync',
        });
        _firestore.set(this, null);
        _usedConfig.set(this, null);
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
    async onReady() {
        var _a, _b, _c, _d;
        const { serviceAccount } = this.config;
        if (!serviceAccount) {
            this.log.error('No service account set, exiting...');
            throw new Error('No service account provided');
        }
        try {
            firebase_admin_1.default.initializeApp({
                credential: firebase_admin_1.default.credential.cert(serviceAccount),
            });
        }
        catch (e) {
            this.log.error('Failed to initialize firebase');
            this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
        }
        try {
            const firestore = firebase_admin_1.default.firestore();
            __classPrivateFieldSet(this, _firestore, firestore);
        }
        catch (e) {
            this.log.error('Failed to initialize firestore');
            this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
        }
        try {
            if (__classPrivateFieldGet(this, _firestore)) {
                await deleteCollection(__classPrivateFieldGet(this, _firestore), 'states');
            }
            else {
                throw new Error('Firestore not present');
            }
        }
        catch (e) {
            this.log.error('Failed to delete old state collection');
            this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
        }
        let builtConfig = {};
        try {
            if (__classPrivateFieldGet(this, _firestore)) {
                const targetTypeRef = __classPrivateFieldGet(this, _firestore).collection('devices')
                    .doc('definitions')
                    .collection('targetTypes');
                const sourceTypeRef = __classPrivateFieldGet(this, _firestore).collection('devices')
                    .doc('definitions')
                    .collection('sourceTypes');
                const rooms = (await __classPrivateFieldGet(this, _firestore).collection('rooms').get()).docs.map((doc) => doc.data().name);
                const devices = (await __classPrivateFieldGet(this, _firestore).collection('devices').get()).docs.map((doc) => {
                    const { name, roomName, sourceType, externalStates, path } = doc.data();
                    return { name, roomName, sourceType, externalStates, path };
                });
                const targetTypes = {};
                for (const doc of (await targetTypeRef.get()).docs) {
                    targetTypes[doc.id] = doc.data().entries;
                }
                const sourceTypes = {};
                for (const doc of (await sourceTypeRef.get()).docs) {
                    sourceTypes[doc.id] = doc.data();
                }
                builtConfig.devices = devices;
                builtConfig.rooms = rooms;
                builtConfig.sourceTypes = sourceTypes;
                builtConfig.targetTypes = targetTypes;
            }
            else {
                throw new Error('Firestore not present');
            }
        }
        catch (e) {
            this.log.error('Failed to build state tree from firestore');
            this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
            builtConfig = null;
        }
        let usedConfig = builtConfig;
        if (!usedConfig) {
            this.log.info('Trying to use manual input as fallback...');
            if ('devices' in serviceAccount && 'sourceTypes' in serviceAccount && 'targetTypes' in serviceAccount) {
                this.log.info('Manual input seems valid');
                usedConfig = serviceAccount;
            }
        }
        __classPrivateFieldSet(this, _usedConfig, usedConfig);
        const { devices, sourceTypes, targetTypes } = usedConfig;
        const oldStates = await this.getStatesAsync('states.*');
        this.log.info('Deleting old states...');
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
            const targetValues = (_a = Object.entries(targetTypes).find(([key]) => key === deviceTargetType)) === null || _a === void 0 ? void 0 : _a[1];
            if (!targetValues) {
                continue;
            }
            const targetDeviceBasePath = `states.${deviceRoomName}.${deviceTargetType}.${deviceName}`;
            for (const targetValueEntry of targetValues) {
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
                        role: 'state',
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${valueBasePath}.timestamp`, {
                    type: 'state',
                    common: {
                        name: 'Timestamp of last change',
                        type: 'string',
                        read: true,
                        write: false,
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
                try {
                    if (__classPrivateFieldGet(this, _firestore)) {
                        await __classPrivateFieldGet(this, _firestore).collection('states')
                            .doc(getStatePath(deviceRoomName, deviceTargetType, deviceName, targetValueName))
                            .set({
                            deviceName,
                            roomName: deviceRoomName,
                            name: targetValueName,
                            value: actualValue,
                            deviceType: deviceTargetType,
                            timestamp: new Date().toUTCString(),
                        });
                    }
                    else {
                        throw new Error('Firestore not present');
                    }
                }
                catch (e) {
                    this.log.error('Failed to initialize state in firestore');
                    this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
                }
            }
        }
        try {
            if (__classPrivateFieldGet(this, _firestore)) {
                __classPrivateFieldGet(this, _firestore).collection('states').onSnapshot((snap) => {
                    snap.docChanges().forEach(async (change) => {
                        var _a;
                        const { deviceName, roomName, name, value, deviceType, synced = false } = change.doc.data();
                        if (synced)
                            return;
                        const statePath = `states.${roomName}.${deviceType}.${deviceName}.${name}.value`;
                        const oldState = (_a = (await this.getStateAsync(statePath))) === null || _a === void 0 ? void 0 : _a.val;
                        if (oldState == value)
                            return;
                        await this.setStateAsync(statePath, { val: value, ack: false });
                    });
                });
                await __classPrivateFieldGet(this, _firestore).collection('settings').doc('firestore-sync').update({ restart: 0 });
                __classPrivateFieldGet(this, _firestore).collection('settings')
                    .doc('firestore-sync')
                    .onSnapshot(async (doc) => {
                    const { restart } = doc.data();
                    if (Date.now() - restart > 1000)
                        return;
                    await doc.ref.update({ restart: -1 });
                    await this.restart();
                });
            }
            else {
                throw new Error('Firestore not present');
            }
        }
        catch (e) {
            this.log.error('Failed to add snapshot listeners');
            this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
        }
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
        var _a, _b, _c, _d, _e, _f, _g;
        if (!__classPrivateFieldGet(this, _usedConfig))
            return;
        if (!state)
            return;
        const isForeign = !id.includes('smart-connect-firestore-sync');
        // Ignore already synced state changes
        if (state.ack && !isForeign) {
            return;
        }
        if (isForeign) {
            const externalDevice = __classPrivateFieldGet(this, _usedConfig).devices.find(({ externalStates }) => externalStates && Object.values(externalStates).find((externalPath) => id.includes(externalPath)));
            const defaultDevice = __classPrivateFieldGet(this, _usedConfig).devices.find(({ path }) => path && id.includes(path));
            const device = defaultDevice || externalDevice;
            if (!device) {
                return;
            }
            let targetPath = undefined;
            let targetValue = undefined;
            const sourceTypeDevice = __classPrivateFieldGet(this, _usedConfig).sourceTypes[device.sourceType];
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
            try {
                if (!__classPrivateFieldGet(this, _firestore))
                    return;
                const doc = await __classPrivateFieldGet(this, _firestore).collection('states')
                    .doc(getStatePath(device.roomName, sourceTypeDevice.targetType, device.name, targetValue));
                try {
                    await doc.update({ value: (_d = state.val) !== null && _d !== void 0 ? _d : null, timestamp: new Date().toUTCString(), synced: true });
                }
                catch (e) {
                    this.log.error('Failed to update state in firestore:');
                    this.log.error(e);
                }
            }
            catch (e) {
                this.log.error('Failed to update state in firestore');
                this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
            }
        }
        else {
            const [, , , roomName, targetDeviceType, deviceName, valueName, valueProperty] = id.split('.');
            if (valueProperty !== 'value')
                return;
            try {
                const device = __classPrivateFieldGet(this, _usedConfig).devices.find(({ roomName: deviceRoomName, name }) => deviceRoomName === roomName && name === deviceName);
                if (!device) {
                    return;
                }
                if (!device.path) {
                    return;
                }
                const { sourceType, path: sourceDeviceBasePath } = device;
                const targetValueDefinition = __classPrivateFieldGet(this, _usedConfig).targetTypes[targetDeviceType].find(({ name }) => valueName === name);
                if (!targetValueDefinition) {
                    return;
                }
                const isExternal = !!targetValueDefinition.external;
                const sourceDeviceType = __classPrivateFieldGet(this, _usedConfig).sourceTypes[sourceType];
                if (!sourceDeviceType) {
                    return;
                }
                const sourceDeviceValue = ((_e = sourceDeviceType.values.find(({ targetValueName }) => targetValueName === valueName)) === null || _e === void 0 ? void 0 : _e.sourceValueName) || valueName;
                if (!sourceDeviceValue) {
                    return;
                }
                const sourceDevicePath = isExternal
                    ? ((_f = Object.entries(device.externalStates).find(([key]) => key === valueName)) === null || _f === void 0 ? void 0 : _f[1]) || ''
                    : `${sourceDeviceBasePath}.${sourceDeviceValue}`;
                await this.setForeignStateAsync(sourceDevicePath, { val: (_g = state.val) !== null && _g !== void 0 ? _g : null });
            }
            catch (_h) { }
        }
    }
}
_firestore = new WeakMap(), _usedConfig = new WeakMap();
if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options) => new SmartConnectFirestoreSync(options);
}
else {
    // otherwise start the instance directly
    (() => new SmartConnectFirestoreSync())();
}
