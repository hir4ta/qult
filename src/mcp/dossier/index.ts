import type { Embedder } from "../../embedder/index.js";
import type { Store } from "../../store/index.js";
import { dossierUpdate, dossierStatus, dossierSwitch, dossierDelete, dossierHistory, dossierRollback, dossierReview, dossierValidate } from "./crud.js";
import { type DossierParams, errorResult, resolveProjectPath } from "./helpers.js";
import { dossierInit } from "./init.js";
import { dossierComplete, dossierGate, dossierCheck, dossierDefer, dossierCancel } from "./lifecycle.js";

export type { DossierParams } from "./helpers.js";

export async function handleDossier(store: Store, emb: Embedder | null, params: DossierParams) {
	const projectPath = resolveProjectPath(params.project_path);

	switch (params.action) {
		case "init":
			return dossierInit(projectPath, store, emb, params);
		case "update":
			return dossierUpdate(projectPath, store, params);
		case "status":
			return dossierStatus(projectPath);
		case "switch":
			return dossierSwitch(projectPath, params);
		case "complete":
			return dossierComplete(projectPath, store, params);
		case "delete":
			return dossierDelete(projectPath, params);
		case "history":
			return dossierHistory(projectPath, params);
		case "rollback":
			return dossierRollback(projectPath, params);
		case "review":
			return dossierReview(projectPath, params);
		case "validate":
			return dossierValidate(projectPath, params);
		case "gate":
			return dossierGate(projectPath, params);
		case "check":
			return dossierCheck(projectPath, params);
		case "defer":
			return dossierDefer(projectPath, params);
		case "cancel":
			return dossierCancel(projectPath, params);
		default:
			return errorResult(`unknown action: ${params.action}`);
	}
}
