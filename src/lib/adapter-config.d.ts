// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
export interface Device {
    name: string;
    path?: string;
    roomName: string;
    sourceType: string;
    externalStates?: { [key: string]: string };
}

export interface FirestoreDevice extends Device {
    type: string;
}

export type Room = string;

export interface FirestoreRoom {
    name: string;
}

export interface UsedConfig {
    rooms: Room[];
    devices: Device[];
    sourceTypes: {
        // Source Type
        [key: string]: {
            targetType: string;
            values: {
                targetValueName: string;
                sourceValueName: string;
            }[];
        };
    };
    targetTypes: {
        [key: string]: { name: string; optional?: boolean; external?: boolean; virtual?: boolean }[];
    };
}
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            serviceAccount: firebase.ServiceAccount;
            jsonOverwrite?: UsedConfig;
            usedConfig: UsedConfig;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
