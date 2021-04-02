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
var _firestore;
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const firebase_admin_1 = __importDefault(require("firebase-admin"));
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
        var _a, _b, _c, _d, _e;
        const { serviceAccount, jsonOverwrite } = this.config;
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
        const firestore = firebase_admin_1.default.firestore();
        __classPrivateFieldSet(this, _firestore, firestore);
        let builtConfig = {};
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
                    await sourceTypeRef.doc(name).set({ entries: sourceType });
                }
                catch (e) {
                    this.log.error(`Failed to add doc with name "${name}"`);
                    this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
                    (_a = this.stop) === null || _a === void 0 ? void 0 : _a.call(this);
                    return;
                }
            }
            for (const [name, targetType] of Object.entries(targetTypes)) {
                try {
                    await targetTypeRef.doc(name).set({ entries: targetType });
                }
                catch (e) {
                    this.log.error(`Failed to add doc with name "${name}"`);
                    this.log.error((e === null || e === void 0 ? void 0 : e.message) || e);
                    return;
                }
            }
        }
        else {
            const rooms = (await firestore.collection('rooms').get()).docs.map((doc) => doc.data().name);
            const devices = (await firestore.collection('rooms').get()).docs.map((doc) => {
                const { name, roomName, sourceType, externalStates, path } = doc.data();
                return { name, roomName, sourceType, externalStates, path };
            });
            const targetTypes = {};
            for (const doc of (await targetTypeRef.get()).docs) {
                targetTypes[doc.id] = doc.data().entries;
            }
            const sourceTypes = {};
            for (const doc of (await sourceTypeRef.get()).docs) {
                sourceTypes[doc.id] = doc.data().entries;
            }
            builtConfig.devices = devices;
            builtConfig.rooms = rooms;
            builtConfig.sourceTypes = sourceTypes;
            builtConfig.targetTypes = targetTypes;
            this.log.info(JSON.stringify(targetTypes));
        }
        const usedConfig = builtConfig;
        const { rooms, devices, sourceTypes, targetTypes } = usedConfig;
        if (jsonOverwrite) {
            for (const room of rooms) {
                try {
                    await firestore.collection('rooms').add({ name: room });
                }
                catch (_f) {
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
        for (const { name: deviceName, roomName: deviceRoomName, sourceType: deviceSourceType, path: devicePath, externalStates, } of devices) {
            const deviceSourceObject = sourceTypes[deviceSourceType];
            if (!deviceSourceObject) {
                continue;
            }
            const { targetType: deviceTargetType, values: sourceValues } = deviceSourceObject;
            const targetValues = (_b = Object.entries(targetTypes).find(([key]) => key === deviceTargetType)) === null || _b === void 0 ? void 0 : _b[1];
            if (!targetValues) {
                continue;
            }
            const targetDeviceBasePath = `states.${deviceRoomName}.${deviceTargetType}.${deviceName}`;
            if (overwrite) {
                const deviceDocData = {
                    name: deviceName,
                    roomName: deviceRoomName,
                    type: deviceTargetType,
                    sourceType: deviceSourceType,
                    path: devicePath,
                    ...(externalStates ? { externalStates } : {}),
                };
                try {
                    await firestore.collection('devices').add(deviceDocData);
                }
                catch (_g) {
                    this.log.error('Failed to add device to firestore:');
                    this.log.error(JSON.stringify(deviceDocData));
                }
            }
            for (const targetValueEntry of targetValues) {
                const { name: targetValueName, external = false, optional = false, virtual = false } = targetValueEntry;
                // Create states in adapter
                const valueBasePath = `${targetDeviceBasePath}.${targetValueName}`;
                const sourceValue = (_c = sourceValues.find(({ targetValueName: target }) => targetValueName === target)) === null || _c === void 0 ? void 0 : _c.sourceValueName;
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
                    actualValue = (_e = (_d = (await this.getForeignStateAsync(sourceValuePath))) === null || _d === void 0 ? void 0 : _d.val) !== null && _e !== void 0 ? _e : null;
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
                    }
                    catch (_h) {
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
        firestore === null || firestore === void 0 ? void 0 : firestore.collection('states').onSnapshot((snap) => {
            snap.docChanges().forEach(async (change) => {
                var _a;
                const { deviceName, roomName, name, value, deviceType } = change.doc.data();
                const statePath = `states.${roomName}.${deviceType}.${deviceName}.${name}.value`;
                const oldState = (_a = (await this.getStateAsync(statePath))) === null || _a === void 0 ? void 0 : _a.val;
                if (oldState == value)
                    return;
                await this.setStateAsync(statePath, { val: value, ack: false });
            });
        });
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        if (!state)
            return;
        const isForeign = !id.includes('smart-connect-firestore-sync');
        // Ignore already synced state changes
        if (!isForeign && state.ack) {
            return;
        }
        if (isForeign) {
            const externalDevice = this.config.usedConfig.devices.find(({ externalStates }) => externalStates && Object.values(externalStates).find((externalPath) => id.includes(externalPath)));
            const defaultDevice = this.config.usedConfig.devices.find(({ path }) => path && id.includes(path));
            const device = defaultDevice || externalDevice;
            if (!device) {
                return;
            }
            let targetPath = undefined;
            let targetValue = undefined;
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
            if (__classPrivateFieldGet(this, _firestore)) {
                const doc = await __classPrivateFieldGet(this, _firestore).collection('states')
                    .where('deviceName', '==', device.name)
                    .where('roomName', '==', device.roomName)
                    .where('name', '==', targetValue)
                    .where('deviceType', '==', sourceTypeDevice.targetType)
                    .limit(1)
                    .get();
                if (doc.docs.length && doc.docs[0].exists) {
                    const docRef = doc.docs[0].ref;
                    const oldValue = (_d = (await docRef.get()).data()) === null || _d === void 0 ? void 0 : _d.value;
                    if ((_e = oldValue != state.val) !== null && _e !== void 0 ? _e : null) {
                        try {
                            await docRef.update({ value: (_f = state.val) !== null && _f !== void 0 ? _f : null, timestamp: new Date().toUTCString() });
                        }
                        catch (_l) {
                            this.log.error('Failed to update state in firestore:');
                            this.log.error(JSON.stringify({ value: (_g = state.val) !== null && _g !== void 0 ? _g : null, timestamp: new Date().toUTCString() }));
                        }
                    }
                }
            }
        }
        else {
            const [, , , roomName, targetDeviceType, deviceName, valueName, valueProperty] = id.split('.');
            if (valueProperty !== 'value')
                return;
            try {
                const device = this.config.usedConfig.devices.find(({ roomName: deviceRoomName, name }) => deviceRoomName === roomName && name === deviceName);
                if (!device) {
                    return;
                }
                if (!device.path) {
                    return;
                }
                const { sourceType, path: sourceDeviceBasePath } = device;
                const targetValueDefinition = this.config.usedConfig.targetTypes[targetDeviceType].find(({ name }) => valueName === name);
                if (!targetValueDefinition) {
                    return;
                }
                const isExternal = !!targetValueDefinition.external;
                const sourceDeviceType = this.config.usedConfig.sourceTypes[sourceType];
                if (!sourceDeviceType) {
                    return;
                }
                const sourceDeviceValue = ((_h = sourceDeviceType.values.find(({ targetValueName }) => targetValueName === valueName)) === null || _h === void 0 ? void 0 : _h.sourceValueName) || valueName;
                if (!sourceDeviceValue) {
                    return;
                }
                const sourceDevicePath = isExternal
                    ? ((_j = Object.entries(device.externalStates).find(([key]) => key === valueName)) === null || _j === void 0 ? void 0 : _j[1]) || ''
                    : `${sourceDeviceBasePath}.${sourceDeviceValue}`;
                await this.setForeignStateAsync(sourceDevicePath, { val: (_k = state.val) !== null && _k !== void 0 ? _k : null });
            }
            catch (_m) { }
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
