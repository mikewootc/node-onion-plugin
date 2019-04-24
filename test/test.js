#!/usr/bin/env node
'use strict'

const OnionPlugin = require('../OnionPlugin.js');
const lstBuildInPlugins = require('./buildin_plugin');
//const lstPlugins = require('./plugin');

let onionPlugin = new OnionPlugin({methods: ['msgIn', 'msgOut']});
onionPlugin.registerPluginList(lstBuildInPlugins);
//onionPlugin.registerPluginList(lstPlugins);
onionPlugin.registerPluginDir(process.cwd() + '/plugin');

let appCtx = {flag: 'appCtxFlag'};
onionPlugin.init(appCtx);
onionPlugin.start(appCtx);

setInterval(() => {
    let ctx = {req: 'TheRequest'};
    onionPlugin.pluginFns.msgIn(ctx);
}, 2000);

// vim:set tw=0:
