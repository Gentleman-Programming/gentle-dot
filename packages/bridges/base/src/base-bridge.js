"use strict";
/**
 * BaseBridge - Abstract base class for all connector bridges
 * Implements Bridge Protocol v1 handshake, heartbeat, and message routing
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseBridge = void 0;
exports.loadBridgeConfig = loadBridgeConfig;
exports.createBridgeConfigFromEnv = createBridgeConfigFromEnv;
var ws_1 = require("ws");
var events_1 = require("events");
var fs = require("fs");
var PROTOCOL_VERSION = 1;
var DEFAULT_RECONNECT_INTERVAL = 5000;
var DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
var DEFAULT_HEARTBEAT_INTERVAL = 30000;
var BaseBridge = /** @class */ (function (_super) {
    __extends(BaseBridge, _super);
    function BaseBridge(config) {
        var _this = _super.call(this) || this;
        _this.ws = null;
        _this.status = 'disconnected';
        _this.sessionId = null;
        _this.reconnectAttempts = 0;
        _this.reconnectTimer = null;
        _this.heartbeatTimer = null;
        _this.pendingPings = new Map(); // seq -> timestamp
        _this.pingSeq = 0;
        _this.messageSeq = 0;
        _this.config = __assign({ reconnectInterval: DEFAULT_RECONNECT_INTERVAL, maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS, heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL }, config);
        return _this;
    }
    /**
     * Connect to the daemon
     */
    BaseBridge.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                if (this.status === 'connecting' || this.status === 'authenticating' || this.status === 'ready') {
                    return [2 /*return*/];
                }
                this.setStatus('connecting');
                console.log("[".concat(this.config.connectorType, "] Connecting to ").concat(this.config.daemonUrl, "..."));
                return [2 /*return*/, new Promise(function (resolve, reject) {
                        _this.ws = new ws_1.default(_this.config.daemonUrl);
                        _this.ws.on('open', function () {
                            console.log("[".concat(_this.config.connectorType, "] WebSocket connected"));
                            _this.sendHello();
                            _this.setStatus('authenticating');
                        });
                        _this.ws.on('message', function (data) {
                            _this.handleMessage(data);
                        });
                        _this.ws.on('close', function (code, reason) {
                            console.log("[".concat(_this.config.connectorType, "] Disconnected: ").concat(code, " ").concat(reason.toString()));
                            _this.handleDisconnect(code, reason.toString());
                        });
                        _this.ws.on('error', function (error) {
                            console.error("[".concat(_this.config.connectorType, "] WebSocket error:"), error);
                            _this.emit('onError', error);
                            if (_this.status === 'connecting' || _this.status === 'authenticating') {
                                reject(error);
                            }
                        });
                        // Connection timeout
                        setTimeout(function () {
                            var _a;
                            if (_this.status === 'connecting' || _this.status === 'authenticating') {
                                (_a = _this.ws) === null || _a === void 0 ? void 0 : _a.close();
                                reject(new Error('Connection timeout'));
                            }
                        }, 10000);
                    })];
            });
        });
    };
    /**
     * Disconnect from the daemon
     */
    BaseBridge.prototype.disconnect = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                this.clearTimers();
                if (this.ws) {
                    this.sendDisconnect();
                    this.ws.close(1000, 'Bridge disconnecting');
                    this.ws = null;
                }
                this.setStatus('disconnected');
                this.reconnectAttempts = 0;
                return [2 /*return*/];
            });
        });
    };
    /**
     * Send hello message (handshake step 1)
     */
    BaseBridge.prototype.sendHello = function () {
        var payload = {
            token: this.config.token,
            protocol: PROTOCOL_VERSION,
            capabilities: this.config.capabilities,
            connectorType: this.config.connectorType,
            connectorId: this.config.connectorId,
            metadata: this.config.metadata,
        };
        this.send('hello', payload);
    };
    /**
     * Handle incoming messages
     */
    BaseBridge.prototype.handleMessage = function (data) {
        try {
            var message = JSON.parse(data.toString());
            if (!message.type || typeof message.timestamp !== 'number') {
                console.warn("[".concat(this.config.connectorType, "] Invalid message format"));
                return;
            }
            switch (message.type) {
                case 'ready':
                    this.handleReady(message.payload);
                    break;
                case 'ping':
                    this.handlePing(message.payload);
                    break;
                case 'pong':
                    this.handlePong(message.payload);
                    break;
                case 'channel_notify':
                    this.handleChannelNotify(message.payload);
                    break;
                case 'connector_event':
                    this.handleConnectorEvent(message.payload);
                    break;
                case 'command':
                    this.handleCommand(message.payload);
                    break;
                case 'command_result':
                    this.handleCommandResult(message.payload);
                    break;
                case 'error':
                    this.handleError(message.payload);
                    break;
                default:
                    console.warn("[".concat(this.config.connectorType, "] Unknown message type: ").concat(message.type));
            }
        }
        catch (error) {
            console.error("[".concat(this.config.connectorType, "] Parse error:"), error);
        }
    };
    /**
     * Handle ready response (handshake step 2)
     */
    BaseBridge.prototype.handleReady = function (payload) {
        this.sessionId = payload.sessionId;
        this.reconnectAttempts = 0;
        this.setStatus('ready');
        this.startHeartbeat();
        this.emit('onReady', payload.sessionId);
        console.log("[".concat(this.config.connectorType, "] Ready (session: ").concat(payload.sessionId, ")"));
    };
    /**
     * Handle ping from daemon
     */
    BaseBridge.prototype.handlePing = function (payload) {
        this.send('pong', { seq: payload.seq });
    };
    /**
     * Handle pong from daemon
     */
    BaseBridge.prototype.handlePong = function (payload) {
        var sentTime = this.pendingPings.get(payload.seq);
        if (sentTime !== undefined) {
            var latency = Date.now() - sentTime;
            this.pendingPings.delete(payload.seq);
            // Could emit latency metric
        }
    };
    /**
     * Handle channel notification from daemon
     */
    BaseBridge.prototype.handleChannelNotify = function (payload) {
        this.emit('onChannelNotify', payload);
    };
    /**
     * Handle connector event from daemon
     */
    BaseBridge.prototype.handleConnectorEvent = function (payload) {
        this.emit('onConnectorEvent', payload);
    };
    /**
     * Handle command from daemon
     */
    BaseBridge.prototype.handleCommand = function (payload) {
        return __awaiter(this, void 0, void 0, function () {
            var result, commandResult, error_1, commandResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.emit('onCommand', payload)];
                    case 1:
                        result = _a.sent();
                        commandResult = {
                            commandId: payload.commandId,
                            success: true,
                            result: result,
                        };
                        this.send('command_result', commandResult);
                        return [3 /*break*/, 3];
                    case 2:
                        error_1 = _a.sent();
                        commandResult = {
                            commandId: payload.commandId,
                            success: false,
                            error: error_1.message,
                        };
                        this.send('command_result', commandResult);
                        return [3 /*break*/, 3];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Handle command result from daemon
     */
    BaseBridge.prototype.handleCommandResult = function (payload) {
        this.emit('onCommandResult', payload);
    };
    /**
     * Handle error from daemon
     */
    BaseBridge.prototype.handleError = function (payload) {
        console.error("[".concat(this.config.connectorType, "] Daemon error: ").concat(payload.code, " - ").concat(payload.message));
        this.emit('onError', new Error("".concat(payload.code, ": ").concat(payload.message)));
    };
    /**
     * Handle disconnection
     */
    BaseBridge.prototype.handleDisconnect = function (code, reason) {
        this.clearTimers();
        this.setStatus('disconnected');
        this.emit('onDisconnect', code, reason);
        // Attempt reconnection if not intentionally closed
        if (code !== 1000 && this.reconnectAttempts < (this.config.maxReconnectAttempts || DEFAULT_MAX_RECONNECT_ATTEMPTS)) {
            this.scheduleReconnect();
        }
    };
    /**
     * Schedule reconnection attempt
     */
    BaseBridge.prototype.scheduleReconnect = function () {
        var _this = this;
        this.reconnectAttempts++;
        var delay = this.config.reconnectInterval || DEFAULT_RECONNECT_INTERVAL;
        console.log("[".concat(this.config.connectorType, "] Reconnecting in ").concat(delay, "ms (attempt ").concat(this.reconnectAttempts, ")"));
        this.reconnectTimer = setTimeout(function () {
            _this.connect().catch(function (error) {
                console.error("[".concat(_this.config.connectorType, "] Reconnect failed:"), error);
            });
        }, delay);
    };
    /**
     * Start heartbeat mechanism
     */
    BaseBridge.prototype.startHeartbeat = function () {
        var _this = this;
        var interval = this.config.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL;
        this.heartbeatTimer = setInterval(function () {
            var _a, _b;
            if (((_a = _this.ws) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.OPEN) {
                var seq = ++_this.pingSeq;
                _this.pendingPings.set(seq, Date.now());
                _this.send('ping', { seq: seq, ts: Date.now() });
                // Check for stale pings
                for (var _i = 0, _c = _this.pendingPings.entries(); _i < _c.length; _i++) {
                    var _d = _c[_i], pingSeq = _d[0], sentTime = _d[1];
                    if (Date.now() - sentTime > interval * 2) {
                        console.warn("[".concat(_this.config.connectorType, "] Heartbeat timeout, reconnecting"));
                        (_b = _this.ws) === null || _b === void 0 ? void 0 : _b.close(1001, 'Heartbeat timeout');
                        break;
                    }
                }
            }
        }, interval);
    };
    /**
     * Send a message to the daemon
     */
    BaseBridge.prototype.send = function (type, payload) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            return;
        }
        var message = {
            type: type,
            payload: payload,
            seq: ++this.messageSeq,
            timestamp: Date.now(),
        };
        this.ws.send(JSON.stringify(message));
    };
    /**
     * Send disconnect message
     */
    BaseBridge.prototype.sendDisconnect = function () {
        this.send('disconnect', {});
    };
    /**
     * Send channel notification to daemon
     */
    BaseBridge.prototype.sendChannelNotify = function (channelId, event, data) {
        this.send('channel_notify', { channelId: channelId, event: event, data: data });
    };
    /**
     * Send connector event to daemon
     */
    BaseBridge.prototype.sendConnectorEvent = function (event, data) {
        this.send('connector_event', {
            connectorId: this.config.connectorId,
            event: event,
            data: data,
        });
    };
    /**
     * Send command to daemon
     */
    BaseBridge.prototype.sendCommand = function (action, params) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            var commandId = "cmd-".concat(Date.now(), "-").concat(Math.random().toString(36).slice(2, 9));
            var handler = function (result) {
                if (result.commandId === commandId) {
                    _this.off('onCommandResult', handler);
                    if (result.success) {
                        resolve(result);
                    }
                    else {
                        reject(new Error(result.error || 'Command failed'));
                    }
                }
            };
            _this.on('onCommandResult', handler);
            // Timeout
            setTimeout(function () {
                _this.off('onCommandResult', handler);
                reject(new Error('Command timeout'));
            }, 30000);
            _this.send('command', {
                commandId: commandId,
                connectorId: _this.config.connectorId,
                action: action,
                params: params,
            });
        });
    };
    /**
     * Get current connection status
     */
    BaseBridge.prototype.getStatus = function () {
        return this.status;
    };
    /**
     * Get session ID
     */
    BaseBridge.prototype.getSessionId = function () {
        return this.sessionId;
    };
    /**
     * Check if connected and ready
     */
    BaseBridge.prototype.isReady = function () {
        var _a;
        return this.status === 'ready' && ((_a = this.ws) === null || _a === void 0 ? void 0 : _a.readyState) === ws_1.default.OPEN;
    };
    /**
     * Set status and emit event
     */
    BaseBridge.prototype.setStatus = function (status) {
        if (this.status !== status) {
            this.status = status;
            this.emit('onStatusChange', status);
        }
    };
    /**
     * Clear all timers
     */
    BaseBridge.prototype.clearTimers = function () {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.pendingPings.clear();
    };
    /**
     * Subscribe to bridge events
     */
    BaseBridge.prototype.on = function (event, handler) {
        _super.prototype.on.call(this, event, handler);
        return this;
    };
    return BaseBridge;
}(events_1.EventEmitter));
exports.BaseBridge = BaseBridge;
/**
 * Load bridge configuration from YAML file
 */
function loadBridgeConfig(configPath) {
    var fileContent = fs.readFileSync(configPath, 'utf-8');
    var yaml = require('yaml');
    var parsed = yaml.parse(fileContent);
    if (!parsed) {
        throw new Error('Config file is empty or invalid YAML');
    }
    return parsed;
}
/**
 * Create bridge config from environment variables
 */
function createBridgeConfigFromEnv(connectorType) {
    var daemonHost = process.env['DAEMON_HOST'] || '127.0.0.1';
    var daemonPort = process.env['DAEMON_PORT'] || '4317';
    var token = process.env['BRIDGE_AUTH_TOKEN'] || 'gentle-dot-bridge-secret';
    return {
        daemonUrl: "ws://".concat(daemonHost, ":").concat(daemonPort, "/ws"),
        connectorId: "".concat(connectorType, "-").concat(process.env['HOSTNAME'] || 'local', "-").concat(process.pid),
        connectorType: connectorType,
        token: token,
        capabilities: [],
        metadata: {},
    };
}
//# sourceMappingURL=base-bridge.js.map