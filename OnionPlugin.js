const Logger = require('cpclog');

const logger = Logger.createWrapper('OnionPlugin', Logger.LEVEL_INFO);

class OnionPlugin {
    constructor(options) {
        this.pluginMethods      = ['init', 'start', 'release'];
        //this.pluginMiddlewares  = {init: [], start: [], release: [], msgIn: [], msgOut: []};
        this.pluginMiddlewares  = {init: [], start: [], release: []};
        this.plugins            = {};
        this.pluginFns= {};

        if (options && options.methods && options.methods instanceof Array) {
            this.pluginMethods = [...this.pluginMethods, ...options.methods];
            options.methods.forEach((it, ix, arr) => {
                this.pluginMiddlewares[it] = [];
            });
        }
    }

    async init(appCtx) {
        try {
            for (let i = 0; i < this.pluginMethods.length; i++) {
                const methodName = this.pluginMethods[i];
                this.pluginFns[methodName] = this.compose(this.pluginMiddlewares[methodName]);
            }

            await this.pluginFns.init(appCtx);
        } catch(err) {
            throw err;
        }
    }

    async start(appCtx) {
        await this.pluginFns.start(appCtx);
    }

    async release(appCtx) {
        await this.pluginFns.release(appCtx);
    }

    async callPluginMethod(method, ctx) {
        await this.pluginFns[method](ctx);
    }

    fnWrapper(fn, pluginName, fnName) {
        let wrapper = async function (ctx, next) {
            logger.trace(fnName, pluginName, 'before');
            await fn(ctx, next);
            logger.trace(fnName, pluginName, 'after');
        };
        wrapper.pluginName = pluginName;
        wrapper.fnName = fnName;

        return wrapper;
    }

    isClass(sth) {
        const isCtorClass = sth.constructor && sth.constructor.toString().substring(0, 5) === 'class';
        if(sth.prototype === undefined) {
            return isCtorClass;
        }

        const isPrototypeCtorClass = sth.prototype.constructor 
            && sth.prototype.constructor.toString
            && sth.prototype.constructor.toString().substring(0, 5) === 'class';

        return isCtorClass || isPrototypeCtorClass;
    }

    registerPlugin(ImportedPlugin) {
        try {
            let plugin;
            if (this.isClass(ImportedPlugin)) { // 导入的plugin是个类...
                plugin = new ImportedPlugin();  // ...instance it
            } else {
                plugin = ImportedPlugin;        // 已经是对象.
            }

            if (!plugin.name) {
                console.error('plugin.name is needed but not existed!');
                throw new TypeError('no plugin name!')
            }

            logger.debug('registerPlugin:', plugin.name);
            for (let i = 0; i < this.pluginMethods.length; i++) {
                const methodName = this.pluginMethods[i];
                //this.use(this.pluginMiddlewares[methodName], plugin[methodName]);
                if (plugin[methodName]) {
                    this.use(this.pluginMiddlewares[methodName], this.fnWrapper(plugin[methodName].bind(plugin), plugin.name, methodName));
                    //this.use(this.pluginMiddlewares[methodName], plugin[methodName].bind(plugin));
                }
            }

            this.plugins[plugin.name] = plugin;
        } catch(err) {
            throw err;
        }
    }

    // 批量注册plugin(列表)
    registerPluginList(lstPlugins) {
        if (!lstPlugins instanceof Array) {
            throw new Error('ArgumentShouldBeArray');
        }
        for (let i = 0; i < lstPlugins.length; i++) {
            this.registerPlugin(lstPlugins[i]);
        }
    }

    registerPluginDir(pluginDir) {
        let lstPlugins = require(pluginDir);
        this.registerPluginList(lstPlugins);
    }

    use(middleware, fn) {
        //logger.debug('in use:', typeof fn);
        if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');
        //logger.debug('use', fn._name || fn.name || '-');
        logger.debug('use', fn.pluginName ? fn.pluginName : 'AnonymousPlugin', fn.fnName ? fn.fnName : 'AnonymousFunc');
        middleware.push(fn);
        return this;
    }

    compose (middleware) {
        //logger.debug('compose', middleware);
        if (!Array.isArray(middleware)) throw new TypeError('Middleware stack must be an array!');
        for (const fn of middleware) {
            if (typeof fn !== 'function') throw new TypeError('Middleware must be composed of functions!')
        }

        /**
         * @param {Object} context
         * @return {Promise}
         * @api public
         */

        return function (context, next) {
            // last called middleware #
            let index = -1;
            return dispatch(0);
            function dispatch (i) {
                if (i <= index) return Promise.reject(new Error('next() called multiple times'));
                index = i;
                let fn = middleware[i];
                if (i === middleware.length)
                    fn = next;
                if (!fn)
                    return Promise.resolve();
                try {
                    return Promise.resolve(fn(context, function next () {
                        return dispatch(i + 1)
                    }))
                } catch (err) {
                    return Promise.reject(err)
                }
            }
        }
    }
}

module.exports = OnionPlugin;
