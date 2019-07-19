'use strict'

// 本文件概念:
// msgChannel: 发送的类型, 即socket.io的eventName. 例如: signaling, inspecting, sms, ...
// 消息转发: 分为 '转发到其他服务器' 与 '转发到其他服务器上的用户' 两种, 由于前者需要返回响应, 而后者不需要, 流程不同, 所以未合并为统一接口.
//   * 转发到其他服务器的消息: 采用直接socketio间的转发(为了借用其ack来传回响应).
//   * 转发到其他服务器上的用户的消息: 采用 redis sub/pub 机制(为了简单, 不用处理ack).

const SocketIo      = require('socket.io');
const request       = require('request');
const Logger        = require('cpclog');
const OnionPlugin   = require('node-onion-plugin');

const Signaling         = require('./Signaling.js');
const AppMsg            = require('./AppMsg.js');
const MessageProxy      = require('./MessageProxy.js');
const Constants         = require('./Constants.js');
const Errors            = require('../server_common/Errors.js');
const ShareMem          = require('../server_common/ShareMem.js');
const ClusterUser       = require('./ClusterUser.js');
const ClusterRoom       = require('./ClusterRoom.js');
const Config            = require('../server_common/Config.js');
//const WithPlugin        = require('./WithPlugin.js');

// TODO: 消息送达保证与离线缓存在本层进行.

const logger = Logger.createWrapper('Messenger', Logger.LEVEL_DEBUG);

//const SERVER_USER_SYSTEM = '47.104.68.131';

class Messenger {
    // serverAddr: like: 1.2.3.4:12345
    constructor(serverHttp, serverAddr) {
        //super();
        /** @type {[string]} */
        logger.debug('httpsSignalingList:', httpsSignalingList);
        this.serverHttp     = serverHttp;
        //this.serverAddr     = serverAddr;
        //this.connectedCnt   = 0;

        this.sockets = {}; // FIXME: 字典效率问题
        //this.onionPlugin = new OnionPlugin({methods: ['msgIn', 'msgOut']});

        //this.appCtx = {
        //    messenger  : this,
        //    serverHttp : this.serverHttp,
        //    serverAddr : this.serverAddr,
        //    smem       : this.smem,
        //    clusterUser: this.clusterUser,
        //    clusterRoom: this.clusterRoom,
        //};
    }

    async init() {
        await this.onionPlugin.registerPluginList([Signaling, AppMsg]);
        await this.onionPlugin.init(this.appCtx);
    }

    async start() {
        await this.smem.start();
        await this.onionPlugin.start(this.appCtx);

        this.sio = SocketIo(this.serverHttp);
        this._watchIoEvent();
        if (this.smem) {
            this.smem.subscribe('msgproxy2' + this.serverAddr, async(smemJsonMsg) => {
                await this._proxyMsgToMyClient(smemJsonMsg);
            });
        }

        setTimeout(() => {
            if (this.messageProxy) {
                this.messageProxy.start();
            }
        }, 1000);
    }

    release() {
    }

    /**
     * Get io req ctx
     *
     * @param {string} channel
     * @param {object} reqMsg
     * @param {function} sendObjAck
     * @returns {object}
     */
    _getReqIoCtx(channel, reqMsg, sendObjAck) {
        return {
            app: this.appCtx,
            req: {
                channel,        // msgChannel {string}
                msg: reqMsg,
                sendObjAck,
            },
            //res: {
            //},
        }
    }

    _checkUserPassword(userId, passwordMd5) {
        logger.debug('_checkUserPassword', userId, passwordMd5);
        return new Promise((resolve, reject) => {
            logger.debug('userServerAddr:', this.userServerAddr);
            let url = `http://${this.userServerAddr}/Client/getUserByUuid?uuid=${userId}&password=${passwordMd5}`;
            logger.debug('url:', url);
            request(url, (err, res, body) => {
                if (err) {
                    logger.error('err:' + err);
                    return null;
                }
                if (res.statusCode != 200) {
                    reject(Error('Status:' + res.status));
                }

                let ret = JSON.parse(res.body);
                if (ret.errcode != 0) {
                    let err = new Errors.UserInfoError({message: 'ErrCode: ' + ret.errcode});
                    err.data = ret;
                    reject(err);
                }
                resolve();
            });
        });
    }

    /**
     * 给用户userId发送消息.
     *
     * @param {string} userId
     * @param {object} msg plane object: type: 信令类型: createRoom, joinRoom, ...
     * @returns {undefined}
     */
    async sendSignaling(userId, msg) {
        try {
            return await this.emitToUser('signaling', userId, msg, false);
        } catch(err) {
            throw err;
        }
    }

    /**
     * 向用户发送消息
     *
     * @param {string} msgChannel
     * @param {string} userId
     * @param {object} msg
     * @param {boolean} offlineCache
     * @returns {undefined}
     */
    async emitToUser(msgChannel, userId, msg, offlineCache) {
        try {
            let jsonMsg = JSON.stringify(msg);
            let toUser = await this.clusterUser.getUser(userId);
            if (userId != 'inspector') {
                logger.trace('emitToUser:', userId);
            }

            // 用户不在线
            if (!toUser) {
                logger.warn('[34mtoUser not online[0m', jsonMsg);
                if (offlineCache) {
                    logger.debug(Logger.BLUE, 'push msg to offline storage');
                    // TODO: 向用户系统检查userId是否存在, 并加入离线队列.
                }
                return;
            }

            // 用户在线但连接的不是本服务器, 转发到其他服务器实例.
            logger.trace('this server:', this.serverAddr, 'toUser@server:', toUser.serverAddr);
            if (toUser.serverAddr != this.serverAddr) {
                logger.trace(Logger.MAGENTA_B, 'pass to other server', toUser.serverAddr);
                let smemJsonMsg = JSON.stringify({jsonMsg, msgChannel, userId}); // FIXME: 此处多套了一层json封装, 考虑改为将所需传递的redis消息的信息直接塞进内层msg中.
                this.smem.publish('msgproxy2' + toUser.serverAddr, smemJsonMsg);
                return;
            }

            // 发送给连接到本server用户
            let socketId = toUser.socketId;
            let toSocket = this.sio.sockets.connected[toUser.socketId];
            if (toSocket) {
                if (userId != 'inspector') {
                    logger.trace(Logger.MAGENTA, '>>>', jsonMsg);
                }
                toSocket.emit(msgChannel, jsonMsg); // TODO: 处理ack.
            } else {
                logger.warn('[01;33mtoUser missed socket[0m', msg);
            }
        } catch(err) {
            throw err;
        }
    }

    async emitToRoom(msgChannel, roomId, msg, options) {
        try {
            let toRoomId = roomId;
            let room = await this.clusterRoom.getRoom(toRoomId);
            if (!room) {
                logger.error(msgChannel + 'NoSuchRoom:', toRoomId);
                throw Error('NoSuchRoom');
            }

            let members = room.members;
            logger.debug('toRoomId:', toRoomId, ', members:', room.members);
            for (var i = 0; i < members.length; i++) {
                msg.to = members[i];
                if (options.excludes && (msg.to in options.excludes)) {
                    continue;
                }
                await this.emitToUser(msgChannel, members[i], msg, options.offlineCache);
            }
        } catch(err) {
            logger.warn(err);
            throw err;
        }
    }

    async proxyToServer(serverAddr, msgChannel, msg, sendObjAck) {
        try {
            if (this.messageProxy) {
                await this.messageProxy.proxyToServer(serverAddr, msgChannel, msg, sendObjAck);
            } else {
                logger.warn('No proxy');
                throw Error('NoSignalingProxy');
            }
        } catch(err) {
            throw err;
        }
    }

    async _handleLogin(userId, socket) {
        try {
            logger.debug(this.serverAddr, 'Got login:', userId, socket.id);
            if (!userId) {
                logger.error('Error: no userId');
                return;
            }

            await this.clusterUser.setUser(userId, socket.id, this.serverAddr);
            this.sockets[socket.id] = userId;
            logger.debug('    send loginResult, to socket:', socket.id);
            socket.emit('loginResult', JSON.stringify({result: 'ok'})); // 此为异步消息, 并非ack, 所以不采用socket.io自带的ack机制回复.
        } catch(err) {
            throw err;
        }
    }

    async _handleLoginSecure(jsonMsg, socket) {
        logger.debug('LoginSecure jsonMsg:', jsonMsg);

        let msg;
        try {
            msg = JSON.parse(jsonMsg);
        } catch(err) {
            logger.warn(err.message);
            socket.emit('loginResult', JSON.stringify({result: 'fail', reason: 'invalidJson'})); // 此为异步消息, 并非ack, 所以不采用socket.io自带的ack机制回复.
            return;
        }
        
        let userId = msg.userId;
        let passwordMd5 = msg.passwordMd5;
        logger.debug(this.serverAddr, 'Got loginSecure:', userId, msg.passwordMd5, socket.id);
        if (!userId) {
            logger.error('Error: no userId 2');
            return;
        }

        try {
            let ret = await this._checkUserPassword(userId, passwordMd5);
            logger.debug('_checkUserPassword ok', userId, socket.id, this.serverAddr);

            // 先发消息通知原本的登录被剔除(用户如果原本不在线, 则该操作没有任何效果).
            await this.emitToUser('login', userId, {type: 'loginStatusNotify', status: 'kickout'}, false);

            await this.clusterUser.setUser(userId, socket.id, this.serverAddr);
            this.sockets[socket.id] = userId;
            logger.info(Logger.GREEN, `User ${userId} logged in`);
            socket.emit('loginResult', JSON.stringify({result: 'ok'})); // 此为异步消息, 并非ack, 所以不采用socket.io自带的ack机制回复.
        } catch(err) {
            // 此为异步消息, 并非ack, 所以不采用socket.io自带的ack机制回复.
            if (err instanceof Errors.UserInfoError) {
                logger.warn('UserInfoError:', err.message);
                socket.emit('loginResult', JSON.stringify({...err.data, result: 'fail'}));
            } else {
                logger.warn(err);
                socket.emit('loginResult', JSON.stringify({result: 'fail', reason: 'Server error'})); // 此为异步消息, 并非ack, 所以不采用socket.io自带的ack机制回复.
            }
        }
    }

    async _handleLogout(userId) {
        try {
            logger.debug(this.serverAddr, 'Got logout:', userId);
            if (!userId) {
                logger.error('Error: no userId');
                return;
            }

            await this.clusterUser.removeUser(userId, socket.id);
            delete this.sockets[socket.id];
        } catch(err) {
            throw err;
        }
    }

    async _handleMsg(msgChannel, jsonMsg, sendAck) {
        logger.trace(`Got ${msgChannel}`);
        let msg;
        try {
            msg = JSON.parse(jsonMsg);
        } catch(err) {
            logger.warn('_handleMsg error:', err.message);
            sendAck && sendAck(JSON.stringify({result: 'fail', reason: 'invalidJson'}));
            return;
        }

        try {
            if (msg.type != Constants.SIGNALING_IS_USER_ONLINE) {
                logger.trace(Logger.CYAN, '<<<', jsonMsg, Date());
            }

            let ioCtx = this._getReqIoCtx(msgChannel, msg, (ack) => {
                // sendObjAck for callback. (ack is a plain object)
                if (ack) {
                    let jsonAck = JSON.stringify(ack);
                    if (msg.type != 'isUserOnline') {
                        logger.trace('[35m>>a', ack, '[0m');
                    }
                    sendAck && sendAck(jsonAck);
                }
            });
            //await this.pluginMiddlewareFns.msgIn(ioCtx);
            await this.onionPlugin.callPluginMethod('msgIn', ioCtx);
        } catch(err) {
            logger.error(`${msgChannel} callback err:`, err);
            sendAck && sendAck(JSON.stringify({result: 'fail', reason: err.toString()}));
        }
    }

    _watchIoEvent() {
        this.sio.on('connection', (socket) => {
            this.connectedCnt++;
            logger.debug(this.serverAddr, 'user connected', this.connectedCnt, 'socketId:', socket.id);
            socket.on('disconnect', async() => {
                this.connectedCnt--;
                let userId = this.sockets[socket.id];
                logger.debug(Logger.YELLOW, this.serverAddr, 'user disconnected', this.connectedCnt, 'socketId:', socket.id, userId);
                if (userId) {
                    let jsonMsg = JSON.stringify({type: Constants.SIGNALING_USER_DISCONNECTED, userId});
                    let user = await this.clusterUser.getUser(userId, socket.id);
                    if (user) {
                        logger.debug('invoke signaling for disconnect');
                        await this._handleMsg('signaling', jsonMsg, null); // FIXME: 
                        await this.clusterUser.removeUser(userId, socket.id);
                    }
                    delete this.sockets[socket.id];
                }
            });

            // 此login不包含用户名密码校验
            socket.on('login', (userId) => {this._handleLogin(userId, socket)});

            socket.on('loginSecure', (jsonMsg) => {this._handleLoginSecure(jsonMsg, socket)});

            socket.on('logout', (userId) => {this._handleLogout(userId, socket)});


            socket.on('signaling', (jsonMsg, sendAck) => {
                this._handleMsg('signaling', jsonMsg, sendAck);
            });
            socket.on('appmsg', (jsonMsg, sendAck) => {
                this._handleMsg('appmsg', jsonMsg, sendAck);
            });

            socket.on('msgping', function(msg) {
                logger.debug(this.serverAddr, 'Got ping:', msg);
                //socket.emit();
                socket.emit('msgpong', msg);
            });

            socket.on('heartbeat', (userId, sendAck) => {
                if (userId) {
                    //logger.debug('[34mheartbeat from:[0m', userId);
                    this.clusterUser.touchUser(userId);
                }
            });
        });
    }

    // 将其他服务器节点转发过来的用户消息, 发给用户.
    async _proxyMsgToMyClient(smemJsonMsg) {
        try {
            logger.trace('[36mGot sub message:[0m', smemJsonMsg);
            let redisMsg = JSON.parse(smemJsonMsg);
            logger.trace('redisMsg:', redisMsg);
            let {jsonMsg, msgChannel, userId} = redisMsg;

            let toUser = await this.clusterUser.getUser(userId);
            let socketId = toUser.socketId;
            let toSocket = this.sio.sockets.connected[toUser.socketId];
            if (toSocket) {
                logger.trace(Logger.MAGENTA, '>>>', jsonMsg);
                toSocket.emit(msgChannel, jsonMsg); // TODO: 处理ack.
            } else {
                logger.warn('toUser missed socket');
            }
        } catch(err) {
            throw err;
        }
    }

    // 连接的sockets的总数
    getSocketsAmount() {
        return Object.keys(this.sockets).length;
    }
}

module.exports = Messenger;



// vim:set tw=0:
