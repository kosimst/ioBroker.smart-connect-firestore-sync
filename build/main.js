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
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, privateMap) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to get private field on non-instance");
    }
    return privateMap.get(receiver);
};
var _lastCurrentValues;
Object.defineProperty(exports, "__esModule", { value: true });
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = __importStar(require("@iobroker/adapter-core"));
// Load your modules here, e.g.:
// import * as fs from "fs";
class SmartConnectFirestoreSync extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'smart-connect-firestore-sync',
        });
        _lastCurrentValues.set(this, new Map());
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
        const { devices, sourceTypes } = this.config;
        this.log.info(`Adapter ${this.name} ready`);
        const oldStates = await this.getStatesAsync('states.*');
        for (const [path] of Object.entries(oldStates || {})) {
            const usedPath = path.split('0.')[1];
            // TODO: Check if state should be kept
            this.log.info(`Deleting state ${usedPath}...`);
            await this.delObjectAsync(usedPath);
        }
        for (const { name: deviceName, roomName: deviceRoomName, sourceType: deviceSourceType, path: devicePath, externalStates, } of devices) {
            const deviceSourceObject = sourceTypes[deviceSourceType];
            if (!deviceSourceObject) {
                this.log.warn(`Failed to set up device ${deviceName} as no source device definition could be found`);
                continue;
            }
            const { targetType: deviceTargetType, values: sourceValues } = deviceSourceObject;
            this.log.info(`Device is typeof "${deviceTargetType}" (${deviceSourceType})`);
            const targeValues = (_a = Object.entries(this.config.targetTypes).find(([key]) => key === deviceTargetType)) === null || _a === void 0 ? void 0 : _a[1];
            this.log.info(JSON.stringify(targeValues));
            if (!targeValues) {
                this.log.warn(`Failed to set up device ${deviceName} as no target device values could be found`);
                continue;
            }
            const targetDeviceBasePath = `states.${deviceRoomName}.${deviceTargetType}.${deviceName}`;
            this.log.info(`Setting up "${deviceName}" in "${deviceRoomName}"...`);
            for (const targetValueEntry of targeValues) {
                this.log.info(JSON.stringify(targetValueEntry));
                const { name: targetValueName, external = false, optional = false, virtual = false } = targetValueEntry;
                // Create states in adapter
                const valueBasePath = `${targetDeviceBasePath}.${targetValueName}`;
                this.log.info(`Creating "${targetValueName}" value...`);
                const sourceValue = (_b = sourceValues.find(({ targetValueName: target }) => targetValueName === target)) === null || _b === void 0 ? void 0 : _b.sourceValueName;
                if (!sourceValue && !optional && !virtual) {
                    this.log.error(`Could not find value mapping for ${deviceName} (${targetValueName}->${sourceValue})`);
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
                        this.log.error(`Could not find matching source device value for "${targetValueName}" (${deviceName})`);
                        continue;
                    }
                    sourceValuePath = external ? externalStates[targetValueName] : `${devicePath}.${sourceValue}`;
                    actualValue = (_d = (_c = (await this.getForeignStateAsync(sourceValuePath))) === null || _c === void 0 ? void 0 : _c.val) !== null && _d !== void 0 ? _d : null;
                    __classPrivateFieldGet(this, _lastCurrentValues).set(sourceValuePath, actualValue);
                    await this.subscribeForeignStatesAsync(sourceValuePath);
                }
                this.log.info(`Created "${targetValueName}" with value ${actualValue}`);
                await this.setStateAsync(`${valueBasePath}.value`, { val: actualValue, ack: true });
                await this.setStateAsync(`${valueBasePath}.previous`, null);
                await this.setStateAsync(`${valueBasePath}.timestamp`, { val: Date.now(), ack: true });
            }
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
    async onStateChange(id, state) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        if (!state)
            return;
        this.log.info(`State "${id}" changed by ${state.from}`);
        const isSelfModified = state.from.includes('smart-connect-firestore-sync');
        if (isSelfModified) {
            this.log.info('State change was self-modified, ignoring...');
            return;
        }
        const isForeign = !id.includes('smart-connect-firestore-sync');
        if (isForeign) {
            const devicePath = (_a = this.config.devices.find(({ path }) => path && id.includes(path))) === null || _a === void 0 ? void 0 : _a.path;
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
            const targetValue = ((_b = sourceTypeDevice.values.find(({ sourceValueName }) => sourceValueName === sourceValue)) === null || _b === void 0 ? void 0 : _b.targetValueName) || sourceValue;
            if (!targetValue) {
                this.log.warn(`No target value mapping found for state change`);
                return;
            }
            const targetPath = `states.${device.roomName}.${sourceTypeDevice.targetType}.${device.name}.${targetValue}`;
            const previousValue = (_c = (await this.getStateAsync(`${targetPath}.value`))) === null || _c === void 0 ? void 0 : _c.val;
            await this.setStateAsync(`${targetPath}.value`, { val: (_d = state.val) !== null && _d !== void 0 ? _d : null, ack: true });
            await this.setStateAsync(`${targetPath}.previous`, { val: previousValue !== null && previousValue !== void 0 ? previousValue : null, ack: true });
            await this.setStateAsync(`${targetPath}.timestamp`, { val: Date.now(), ack: true });
        }
        else {
            const [, , , roomName, targetDeviceType, deviceName, valueName, valueProperty] = id.split('.');
            const devicePath = `states.${roomName}.${targetDeviceType}.${deviceName}.${valueName}`;
            if (valueProperty !== 'value')
                return;
            try {
                const device = this.config.devices.find(({ roomName: deviceRoomName, name }) => deviceRoomName === roomName && name === deviceName);
                if (!device)
                    throw new Error('No device found to changed state');
                if (!device.path)
                    return;
                const { sourceType, path: sourceDeviceBasePath } = device;
                const sourceDeviceType = this.config.sourceTypes[sourceType];
                if (!sourceDeviceType)
                    throw new Error('No source device type found for state change');
                const sourceDeviceValue = ((_e = sourceDeviceType.values.find(({ targetValueName }) => targetValueName === valueName)) === null || _e === void 0 ? void 0 : _e.sourceValueName) || valueName;
                if (!sourceDeviceValue)
                    throw new Error('No value mapping found for state change');
                const sourceDevicePath = `${sourceDeviceBasePath}.${sourceDeviceValue}`;
                await this.setForeignStateAsync(sourceDevicePath, { val: (_f = state.val) !== null && _f !== void 0 ? _f : null });
                await this.setStateAsync(`${devicePath}.timestamp`, { ack: true, val: Date.now() });
                await this.setStateAsync(`${devicePath}.previous`, {
                    val: (_g = __classPrivateFieldGet(this, _lastCurrentValues).get(sourceDevicePath)) !== null && _g !== void 0 ? _g : null,
                    ack: true,
                });
                __classPrivateFieldGet(this, _lastCurrentValues).set(sourceDevicePath, (_h = state.val) !== null && _h !== void 0 ? _h : null);
                await this.setStateAsync(`${devicePath}.value`, { val: (_j = state.val) !== null && _j !== void 0 ? _j : null, ack: true });
            }
            catch (e) {
                this.log.warn(e.message);
                const prevValue = (_k = (await this.getStateAsync(`${devicePath}.previous`))) === null || _k === void 0 ? void 0 : _k.val;
                await this.setStateAsync(`${devicePath}.value`, { ack: true, val: prevValue !== null && prevValue !== void 0 ? prevValue : null });
            }
        }
    }
}
_lastCurrentValues = new WeakMap();
if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options) => new SmartConnectFirestoreSync(options);
}
else {
    // otherwise start the instance directly
    (() => new SmartConnectFirestoreSync())();
}
