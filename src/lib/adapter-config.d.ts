// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            serviceAccount?: string | firebase.ServiceAccount;
            rooms: string[];
            devices: {
                name: string;
                path?: string;
                roomName: string;
                sourceType: string;
                externalStates?: { [key: string]: string };
            }[];
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
            scenes?: {
                name: string;
                path?: string;
                roomName: string;
            }[];
            routines?: { name: string; path?: string; roomName: string }[];
            plugins: {
                alarm?: boolean;
                gh?:
                    | false
                    | {
                          name: string;
                          roomName: string;
                      }[];
                geofencing?: boolean;
                scenes?: boolean;
                routines?: boolean;
            };
            /*users: {
                email: string;
                name: string;
                avatar?: string;
                admin?: boolean;
                settings?: {
                    favorites?: string[];
                };
                connections?: {
                    spotify?: {
                        token: string;
                    };
                    // TODO: Type Push Notifications Tokens correctly
                    notifications?: {
                        tokens: string[];
                    };
                };
            }[];
            apps: {
                spotify: {
                    clientId: string;
                    clientSecret: string;
                    scopes: string;
                };
            };*/
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
