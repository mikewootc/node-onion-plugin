'use strict'


const Logger        = require('cpclog');

const logger = Logger.createWrapper('Buildin1', Logger.LEVEL_DEBUG);

class Buildin1 {
    constructor() {
        //super();
        this.name = 'Buildin1';
        this.appCtx = null;
    }

    async init(appCtx, next) {
        this.appCtx = appCtx;

        //appCtx.router.post('/sysctrl', this.control);
        logger.debug('init stage 1', appCtx.flag);
        await next();
        logger.debug('init stage 2', appCtx.flag);
    }

    async start(appCtx, next) {
        logger.debug('start stage 1', appCtx.flag);
        await next();
        logger.debug('start stage 2', appCtx.flag);
    }

    async release(appCtx, next) {
        logger.debug('release stage 1', appCtx.flag);
        await next();
        logger.debug('release stage 2', appCtx.flag);
    }

    async msgIn(ctx, next) {
        logger.debug('msgIn stage 1', ctx.req);
        await next();
        logger.debug('msgIn stage 2', ctx.req);
    }

    async msgOut(ctx, next) {
        logger.debug('msgOut stage 1', ctx.req);
        await next();
        logger.debug('msgOut stage 2', ctx.req);
    }
}

module.exports = Buildin1;
