import * as vscode from 'vscode';
import { ConfigPaths } from './config';
import { spawn } from 'child_process';
import path = require('path');
import { HookitTaskItem, HookitTaskSessionItem, TasksProvider } from './views/tasks';

// hoo-kit imports
import { Api } from '@wow-kit/hoo-kit/dist/ipc-api';
import { HookitTask } from '@wow-kit/hoo-kit/dist/types';
import { Resource } from '@wow-kit/hoo-kit/dist/resources';
import { TaskInstance } from '@wow-kit/hoo-kit/dist/event-system/task-manager';
import { RemoteSessionMessage } from '@wow-kit/hoo-kit/dist/session/remoteSession';
import { handleSessionRequest } from './terminal';

let extensionContext: vscode.ExtensionContext;
export function getExtensionContext() {
	return extensionContext;
}

export function registerDisposable(disposable: vscode.Disposable) {
	getExtensionContext().subscriptions.push(disposable);
}

export function setExtensionContext(name: string, context: unknown) {
	vscode.commands.executeCommand('setContext', name, context);
}

const publicContextListener = new Map<string, ((newValue: unknown) => void)[]>();
export function listenForPublicContext(prop: string, callback: (newValue: unknown) => void) {
	if (!publicContextListener.has(prop)) {
		publicContextListener.set(prop, []);
	}
	publicContextListener.get(prop)?.push(callback);
}
const publicContext = new Proxy(
	{},
	{
		set(target: { [key: string]: unknown }, prop: string, value: unknown) {
			target[prop] = value;
			setExtensionContext('hoo-kit.' + prop, value);
			const listeners = publicContextListener.get(prop);
			if (listeners && listeners.length > 0) {
				listeners.forEach((cb) => cb(value));
			}
			return true;
		}
	}
) as {
	[key: string]: unknown;
	active: boolean;
	running: boolean;
};
// init defaults
Object.entries({
	active: false,
	running: false
}).forEach((entry) => {
	publicContext[entry[0]] = entry[1];
});

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;

	setTimeout(() => {
		if (shouldActivate()) {
			initialize();
		}
	}, 0);

	vscode.workspace.onDidChangeConfiguration((cce) => {
		if (cce.affectsConfiguration(ConfigPaths.HooKit)) {
			if (shouldActivate()) {
				if (!publicContext.active) {
					initialize();
				}
			} else {
				if (publicContext.active) {
					dispose();
					publicContext.active = false;
				}
			}
		}
	});
}

export async function deactivate() {
	if (publicContext.running) {
		await stopHookit();
	}
	dispose();
}

export function dispose() {
	extensionContext.subscriptions.forEach((d) => d.dispose());
	extensionContext.subscriptions.length = 0;
}

export function getConfig<T>(configPath: ConfigPaths): T[] {
	return (
		vscode.workspace.workspaceFolders?.map((ws) => {
			const config = vscode.workspace.getConfiguration(ConfigPaths.HooKit, ws.uri);
			return config.get(configPath) as T;
		}) || []
	);
}

function shouldActivate() {
	// only activate if any of the open workspaces has an hoo-kit active flag
	return getConfig<boolean>(ConfigPaths.Active).some((a) => a === true);
}

export const onInitialize: (() => void)[] = [];
function initialize() {
	declareCommands();
	declareViews();

	onInitialize.forEach((cb) => cb());

	const shouldStart = getConfig<boolean>(ConfigPaths.RunOnStart).some((a) => a === true);
	if (true || shouldStart) {
		startHookit();
	}

	publicContext.active = true;
}

const commands = [
	{ command: 'start', action: () => startHookit() },
	{ command: 'stop', action: () => stopHookit() },
	{
		command: 'event.activate',
		action: (taskNode: HookitTaskItem) => {
			console.log(taskNode);
		}
	},
	{
		command: 'event.deactivate',
		action: (taskNode: HookitTaskItem) => {
			console.log(taskNode);
		}
	},
	{
		command: 'session.terminate',
		action: (sessionNode: HookitTaskSessionItem) => {
			console.log(sessionNode);
		}
	}
];
function declareCommands() {
	commands.forEach((commandDef) => {
		registerDisposable(vscode.commands.registerCommand('hoo-kit.' + commandDef.command, commandDef.action));
	});
}

let tasksProvider: TasksProvider;
function declareViews() {
	tasksProvider = new TasksProvider();
	registerDisposable(
		vscode.window.createTreeView('hoo-kit.tasks', {
			treeDataProvider: tasksProvider
		})
	);
}

export let hookitApi: Api;
const DEFAULT_PORT = 41234;
const DEFAULT_HOST = '127.0.0.1';

export const resources: { [resource: string]: unknown } = {};
function handleResourceChange(resourceChange: { resourceData: unknown; resourceType: Resource }) {
	resources[resourceChange.resourceType] = resourceChange.resourceData;
	switch (resourceChange.resourceType) {
		case Resource.Tasks:
			tasksProvider.tasksChanged(resourceChange.resourceData as HookitTask[]);
			break;
		case Resource.TaskInstances:
			tasksProvider.taskInstancesChanged(resourceChange.resourceData as TaskInstance[]);
			break;
	}
}

async function startHookit() {
	if (!publicContext.running) {
		const extensionDir = path.resolve(__dirname, '../');

		await new Promise((res) => {
			const hookit = spawn('hoo-kit', ['--skipDefaultInit=true', '--runUiServer=false', '--udpPort=' + DEFAULT_PORT], {
				shell: true,
				cwd: extensionDir
			});
			hookit.on('error', (err) => console.error(err));
			hookit.stderr.on('data', (msg: Buffer) => console.error(msg.toString()));
			hookit.stdout.on('data', (msg: Buffer) => {
				const lines = msg.toString();
				console.log(lines);
				if (lines.includes('hoo-kit running')) {
					hookitApi = new Api(DEFAULT_PORT, DEFAULT_HOST, res);
				}
			});
		});

		await hookitApi.subscribeForResourceChange(handleResourceChange);

		await hookitApi.useRemoteSession(handleSessionRequest);

		const tasks = getConfig<HookitTask[]>(ConfigPaths.Tasks)[0];
		await hookitApi.setConfig({ tasks }, () => console.log('on Save called'));

		await hookitApi.initialize();

		publicContext.running = true;
	}
}

async function stopHookit() {
	if (publicContext.running) {
		publicContext.running = false;
	}
}
