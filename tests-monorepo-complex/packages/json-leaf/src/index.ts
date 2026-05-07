import config from "./config.json";

export interface JsonLeafPayload {
	readonly label: string;
	readonly count: number;
}

export const JSON_LEAF_VALUE = `${config.label}:${config.count}`;
