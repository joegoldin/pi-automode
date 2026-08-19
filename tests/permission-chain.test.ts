import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	AUTHORIZER_NAME,
	DEFAULT_LOG_CONFIG,
	DEFAULT_PROTECTED_PATHS,
	PERMISSION_SERVICE_KEY,
	PERMISSIONS_READY_CHANNEL,
	agentDir,
	authorizerChainPaths,
	deterministicDenial,
	eventFromDetails,
	getPermissionsService,
	parseToolPattern,
	readChainActivation,
	withPermissionChain,
	type AuthorizeFn,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function baseConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	return {
		enabled: true,
		classifyReadOnlyTools: false,
		allowInsideWorkingDirectory: false,
		deniedPaths: [],
		fastClassifierMaxTokens: 512,
		maxUserTranscriptTokens: 4000,
		maxToolTranscriptTokens: 4000,
		environment: [],
		allow: [],
		protectedPaths: [...DEFAULT_PROTECTED_PATHS],
		softDeny: [],
		hardDeny: [],
		permissionDeny: [],
		permissionAsk: [],
		log: { ...DEFAULT_LOG_CONFIG },
		...overrides,
	};
}

function createHost() {
	const handlers = new Map<string, Handler[]>();
	const channels = new Map<string, Array<(data: unknown) => void>>();
	const entries: Array<{ customType: string; data: unknown }> = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data: structuredClone(data) });
		},
		registerCommand() {},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				channels.set(channel, [...(channels.get(channel) ?? []), handler]);
				return () => {};
			},
		},
	} as any;

	return {
		pi,
		entries,
		async emit(event: string, payload: any, ctx: any) {
			let last: unknown;
			for (const handler of handlers.get(event) ?? []) {
				last = await handler(payload, ctx);
				if ((last as { block?: boolean } | undefined)?.block) return last;
			}
			return last;
		},
		publish(channel: string) {
			for (const handler of channels.get(channel) ?? []) handler(undefined);
		},
	};
}

function createCtx(overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		cwd: "/tmp/project",
		hasUI: true,
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
		notifications,
		...overrides,
	} as any;
}

/** A stand-in for upstream's gate: records its calls, answers what it is told. */
function createInner(result: unknown = undefined) {
	const calls: Array<{ event: any; ctx: any }> = [];
	let answer = result;
	return {
		calls,
		answerWith(next: unknown) {
			answer = next;
		},
		factory(pi: any) {
			pi.on("tool_call", async (event: any, ctx: any) => {
				calls.push({ event, ctx });
				if (answer instanceof Error) throw answer;
				return typeof answer === "function" ? (answer as () => unknown)() : answer;
			});
			pi.registerCommand("automode", { handler: () => {} });
		},
	};
}

function createService() {
	const registered = new Map<string, AuthorizeFn>();
	let throwOnRegister = false;
	return {
		registered,
		failNext() {
			throwOnRegister = true;
		},
		service: {
			registerAuthorizer(name: string, authorize: AuthorizeFn) {
				if (throwOnRegister) throw new Error("already registered");
				registered.set(name, authorize);
				return () => registered.delete(name);
			},
		},
	};
}

function createLog() {
	const review: Array<[string, Record<string, unknown> | undefined]> = [];
	const debug: Array<[string, Record<string, unknown> | undefined]> = [];
	return {
		review,
		debug,
		log: {
			review(event: string, details?: Record<string, unknown>) {
				review.push([event, details]);
			},
			debug(event: string, details?: Record<string, unknown>) {
				debug.push([event, details]);
			},
		},
	};
}

const noActivation = () => ({ active: true, read: [], names: [AUTHORIZER_NAME] });

function bashCall(command: string, toolCallId = "call-1") {
	return { type: "tool_call", toolCallId, toolName: "bash", input: { command } } as any;
}

test("PERMISSION_SERVICE_KEY is the symbol pi-permission-system publishes on", () => {
	assert.equal(PERMISSION_SERVICE_KEY, Symbol.for("@gotgenes/pi-permission-system:service"));
	assert.equal(PERMISSIONS_READY_CHANNEL, "permissions:ready");
});

test("getPermissionsService reads the slot without importing the package", () => {
	const { service } = createService();
	assert.equal(getPermissionsService({} as never), undefined);
	assert.equal(getPermissionsService({ [PERMISSION_SERVICE_KEY]: service } as never), service);
	assert.equal(getPermissionsService({ [PERMISSION_SERVICE_KEY]: { nope: 1 } } as never), undefined);
	assert.equal(getPermissionsService({ [PERMISSION_SERVICE_KEY]: null } as never), undefined);
});

test("agentDir honours PI_CODING_AGENT_DIR and falls back to pi's default", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/srv/agent" }), "/srv/agent");
	assert.ok(agentDir({}).endsWith(join(".pi", "agent")));
});

test("authorizerChainPaths names the global file then the project one", () => {
	const paths = authorizerChainPaths("/work/repo", "/srv/agent");
	assert.deepEqual(paths, [
		"/srv/agent/extensions/pi-permission-system/config.json",
		"/work/repo/.pi/extensions/pi-permission-system/config.json",
	]);
});

test("readChainActivation reports whether the operator named the link", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-chain-"));
	try {
		const path = join(dir, "extensions", "pi-permission-system", "config.json");
		mkdirSync(dirname(path), { recursive: true });

		writeFileSync(path, JSON.stringify({ debugLog: false }));
		let activation = readChainActivation("/nowhere", dir);
		assert.equal(activation.active, false);
		assert.deepEqual(activation.read, [path]);
		assert.deepEqual(activation.names, []);

		writeFileSync(path, JSON.stringify({ authorizerChain: ["someone-else", AUTHORIZER_NAME] }));
		activation = readChainActivation("/nowhere", dir);
		assert.equal(activation.active, true);
		assert.deepEqual(activation.names, ["someone-else", AUTHORIZER_NAME]);

		writeFileSync(path, "{ not json");
		activation = readChainActivation("/nowhere", dir);
		assert.equal(activation.active, false);
		assert.deepEqual(activation.read, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readChainActivation on a machine with no config file reports inactive", () => {
	const activation = readChainActivation("/nowhere", "/nowhere-either");
	assert.deepEqual(activation, { active: false, read: [], names: [] });
});

test("eventFromDetails reconstructs the input under the key each tool reads", () => {
	assert.deepEqual(eventFromDetails({ toolCallId: "c1", toolName: "bash", command: "rm -rf /" }), {
		type: "tool_call",
		toolCallId: "c1",
		toolName: "bash",
		input: { command: "rm -rf /" },
	});
	assert.deepEqual(eventFromDetails({ toolName: "read", path: "/etc/shadow" })?.input, {
		path: "/etc/shadow",
	});
	assert.deepEqual(eventFromDetails({ toolName: "my_ext:fetch", value: "https://x" })?.input, {
		value: "https://x",
	});
});

test("eventFromDetails falls back to the payload facts, and declines without a tool", () => {
	const event = eventFromDetails({
		payload: { request: { toolName: "bash", value: "git push --force" } },
	});
	assert.equal(event?.toolName, "bash");
	assert.deepEqual(event?.input, { command: "git push --force" });
	assert.equal(eventFromDetails({}), undefined);
	assert.equal(eventFromDetails({ command: "ls" }), undefined);
});

test("deterministicDenial fires on the operator's deny list", () => {
	const config = baseConfig({ permissionDeny: [parseToolPattern("bash(sudo *)")!] });
	assert.match(
		deterministicDenial(config, bashCall("sudo rm -rf /"), "/tmp/project") ?? "",
		/permissions\.deny: bash\(sudo \*\)/,
	);
	assert.equal(deterministicDenial(config, bashCall("ls"), "/tmp/project"), undefined);
});

test("deterministicDenial fires on the built-in hard-deny checks", () => {
	const config = baseConfig();
	assert.ok(
		deterministicDenial(config, bashCall("echo pwned >> ~/.bashrc"), "/tmp/project") !== undefined,
	);
});

test("deterministicDenial fires on deniedPaths for a file tool", () => {
	const config = baseConfig({ deniedPaths: ["/run/agenix/*"] });
	const event = {
		type: "tool_call",
		toolCallId: "c1",
		toolName: "read",
		input: { path: "/run/agenix/anthropic_api_key" },
	} as any;
	assert.match(deterministicDenial(config, event, "/tmp/project") ?? "", /Path denied by policy/);
});

test("deterministicDenial never consults the classifier tiers", () => {
	// An action with no deterministic rule against it is passed on, not allowed
	// on this path: allowing is the permission system's call in delegated mode.
	const config = baseConfig({ allow: ["anything"], allowInsideWorkingDirectory: true });
	assert.equal(deterministicDenial(config, bashCall("touch out"), "/tmp/project"), undefined);
});

test("with no permission system the upstream gate runs unchanged", async () => {
	const host = createHost();
	const inner = createInner({ block: true, reason: "[pi-automode] nope" });
	withPermissionChain(inner.factory, { global: {} as never, loadConfig: () => baseConfig() })(host.pi);

	const result = await host.emit("tool_call", bashCall("rm -rf /"), createCtx());
	assert.deepEqual(result, { block: true, reason: "[pi-automode] nope" });
	assert.equal(inner.calls.length, 1);
});

test("with a permission system present the gate stands down and the link decides", async () => {
	const host = createHost();
	const { service, registered } = createService();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);

	const ctx = createCtx();
	const event = bashCall("touch RAN_FOR_REAL");
	assert.equal(await host.emit("tool_call", event, ctx), undefined);
	assert.equal(inner.calls.length, 0, "the classifier must not run twice");

	const authorize = registered.get(AUTHORIZER_NAME);
	assert.ok(authorize);
	const log = createLog();
	const verdict = await authorize({ requestId: "r1", toolCallId: "call-1" }, {}, log.log);
	assert.deepEqual(verdict, { kind: "allow" });
	assert.equal(inner.calls.length, 1);
	assert.equal(inner.calls[0]!.event, event, "the link reviews the real event, not a projection");
	assert.equal(inner.calls[0]!.ctx, ctx);
	assert.equal(log.review[0]![0], AUTHORIZER_NAME);
	assert.equal(log.review[0]![1]!.decision, "allow");
	assert.equal(log.review[0]![1]!.projected, false);
});

test("the link denies with the gate's own reason", async () => {
	const host = createHost();
	const { service, registered } = createService();
	const inner = createInner({ block: true, reason: "[pi-automode] not asked for" });
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);
	await host.emit("tool_call", bashCall("rm -rf CANARY"), createCtx());

	const log = createLog();
	const verdict = await registered.get(AUTHORIZER_NAME)!(
		{ requestId: "r1", toolCallId: "call-1" },
		{},
		log.log,
	);
	assert.deepEqual(verdict, { kind: "deny", reason: "[pi-automode] not asked for" });
	assert.equal(log.review[0]![1]!.decision, "deny");
});

test("a fail-closed block from the gate reaches the chain as a deny, not a defer", async () => {
	const host = createHost();
	const { service, registered } = createService();
	// What the gate returns when the classifier errors, replies unparseably, or
	// matches permissions.ask with no UI.
	const inner = createInner({
		block: true,
		reason: "[pi-automode] Fast classifier failed; auto mode fails closed",
	});
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);
	await host.emit("tool_call", bashCall("rm -rf CANARY"), createCtx());

	const verdict = await registered.get(AUTHORIZER_NAME)!(
		{ requestId: "r1", toolCallId: "call-1" },
		{},
		createLog().log,
	);
	assert.equal(verdict.kind, "deny");
});

test("the link defers, and never allows, when the gate throws", async () => {
	const host = createHost();
	const { service, registered } = createService();
	const inner = createInner(new Error("boom"));
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);
	await host.emit("tool_call", bashCall("rm -rf CANARY"), createCtx());

	const log = createLog();
	const verdict = await registered.get(AUTHORIZER_NAME)!(
		{ requestId: "r1", toolCallId: "call-1" },
		{},
		log.log,
	);
	assert.deepEqual(verdict, { kind: "defer" });
	assert.notEqual(verdict.kind, "allow");
	assert.equal(log.debug[0]![1]!.error, "boom");
});

test("the link defers when the ask carries nothing it can review", async () => {
	const host = createHost();
	const { service, registered } = createService();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);
	await host.emit("session_start", {}, createCtx());

	const verdict = await registered.get(AUTHORIZER_NAME)!(
		{ requestId: "r1" },
		{},
		createLog().log,
	);
	assert.deepEqual(verdict, { kind: "defer" });
	assert.equal(inner.calls.length, 0);
});

test("a forwarded ask with no local tool call is reviewed from the projection", async () => {
	const host = createHost();
	const { service, registered } = createService();
	const inner = createInner({ block: true, reason: "[pi-automode] denied" });
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);
	await host.emit("session_start", {}, createCtx());

	const log = createLog();
	const verdict = await registered.get(AUTHORIZER_NAME)!(
		{ requestId: "r1", toolCallId: "elsewhere", toolName: "bash", command: "rm -rf /" },
		{},
		log.log,
	);
	assert.equal(verdict.kind, "deny");
	assert.deepEqual(inner.calls[0]!.event.input, { command: "rm -rf /" });
	assert.equal(log.review[0]![1]!.projected, true);
});

test("the delegated pre-pass still blocks on the deterministic deny list", async () => {
	const host = createHost();
	const { service } = createService();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig({ permissionDeny: [parseToolPattern("bash(sudo *)")!] }),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);

	const result = (await host.emit("tool_call", bashCall("sudo rm -rf /"), createCtx())) as any;
	assert.equal(result.block, true);
	assert.match(result.reason, /permissions\.deny/);
	assert.equal(inner.calls.length, 0);
});

test("the delegated pre-pass stands down entirely when auto mode is off", async () => {
	const host = createHost();
	const { service } = createService();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig({ enabled: false, permissionDeny: [parseToolPattern("bash(sudo *)")!] }),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);

	assert.equal(await host.emit("tool_call", bashCall("sudo rm -rf /"), createCtx()), undefined);
});

test("registration is retried on permissions:ready, which is re-emitted on /reload", async () => {
	const host = createHost();
	const { service, registered } = createService();
	const inner = createInner(undefined);
	// The slot is empty at load time, exactly as it is before session_start.
	const global: Record<symbol, unknown> = {};
	withPermissionChain(inner.factory, {
		global: global as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	assert.equal(registered.size, 0);

	// Standalone until the link is really on the chain.
	await host.emit("tool_call", bashCall("ls"), createCtx());
	assert.equal(inner.calls.length, 1);

	global[PERMISSION_SERVICE_KEY] = service;
	host.publish(PERMISSIONS_READY_CHANNEL);
	assert.equal(registered.size, 1);
	await host.emit("tool_call", bashCall("ls", "call-2"), createCtx());
	assert.equal(inner.calls.length, 1, "the gate stands down once the link is live");
});

test("a duplicate-registration throw does not drop the live link back to standalone", async () => {
	const host = createHost();
	const { service } = createService();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);
	(service as any).registerAuthorizer = () => {
		throw new Error("An authorizer is already registered for 'pi-automode'.");
	};
	host.publish(PERMISSIONS_READY_CHANNEL);

	assert.equal(await host.emit("tool_call", bashCall("ls"), createCtx()), undefined);
	assert.equal(inner.calls.length, 0);
});

test("a registration that never took leaves the upstream gate in charge", async () => {
	const host = createHost();
	const { service } = createService();
	const inner = createInner({ block: true, reason: "[pi-automode] nope" });
	const throwing = {
		registerAuthorizer() {
			throw new Error("An authorizer is already registered for 'pi-automode'.");
		},
	};
	void service;
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: throwing } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);

	assert.deepEqual(await host.emit("tool_call", bashCall("rm -rf /"), createCtx()), {
		block: true,
		reason: "[pi-automode] nope",
	});
});

test("session_start records the activation state and warns when nobody named the link", async () => {
	const host = createHost();
	const { service } = createService();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: () => ({ active: false, read: ["/agent/config.json"], names: [] }),
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);

	const ctx = createCtx();
	await host.emit("session_start", {}, ctx);
	const entry = host.entries.find((e) => e.customType === "pi-automode-chain");
	assert.ok(entry);
	assert.deepEqual(entry.data, {
		registered: true,
		active: false,
		read: ["/agent/config.json"],
		names: [],
		name: AUTHORIZER_NAME,
	});
	assert.equal(ctx.notifications.length, 1);
	assert.equal(ctx.notifications[0].type, "warning");
	assert.match(ctx.notifications[0].message, /authorizerChain/);
});

test("session_start stays quiet once the link is named", async () => {
	const host = createHost();
	const { service } = createService();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, {
		global: { [PERMISSION_SERVICE_KEY]: service } as never,
		readActivation: noActivation,
		loadConfig: () => baseConfig(),
	})(host.pi);
	host.publish(PERMISSIONS_READY_CHANNEL);

	const ctx = createCtx();
	await host.emit("session_start", {}, ctx);
	assert.equal(ctx.notifications.length, 0);
	assert.equal(host.entries.at(-1)!.data.active, true);
});

test("session_start says nothing at all when the permission system is absent", async () => {
	const host = createHost();
	const inner = createInner(undefined);
	withPermissionChain(inner.factory, { global: {} as never, loadConfig: () => baseConfig() })(host.pi);

	const ctx = createCtx();
	await host.emit("session_start", {}, ctx);
	assert.equal(host.entries.length, 0);
	assert.equal(ctx.notifications.length, 0);
});

test("commands and other registrations pass through the shim untouched", async () => {
	const host = createHost();
	const inner = createInner(undefined);
	let sawCommand = false;
	withPermissionChain((pi: any) => {
		inner.factory(pi);
		pi.appendEntry("probe", { ok: true });
		sawCommand = true;
	}, { global: {} as never, loadConfig: () => baseConfig() })(host.pi);

	assert.equal(sawCommand, true);
	assert.deepEqual(host.entries[0], { customType: "probe", data: { ok: true } });
});
