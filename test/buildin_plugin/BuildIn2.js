'use strict'


const Logger        = require('cpclog');

const logger = Logger.createWrapper('Buildin2', Logger.LEVEL_DEBUG);

class Buildin2 {
    constructor() {
        //super();
        this.name = 'Buildin2';
        this.appCtx = null;
    }

    async init(appCtx, next) {
        this.appCtx = appCtx;

        //appCtx.router.post('/sysctrl', this.control);
        logger.debug('init stage 1');
        await next();
        logger.debug('init stage 2');
    }

    async start(appCtx, next) {
        logger.debug('start stage 1');
        await next();
        logger.debug('start stage 2');
    }

    async release(appCtx, next) {
        logger.debug('release stage 1');
        await next();
        logger.debug('release stage 2');
    }

    async msgIn(ctx, next) {
        logger.debug('msgIn stage 1');
        await next();
        logger.debug('msgIn stage 2');
    }

    //async msgOut(ctx, next) {
    //    logger.debug('msgOut stage 1');
    //    await next();
    //    logger.debug('msgOut stage 2');
    //}
}

module.exports = Buildin2;
