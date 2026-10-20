// 交接模拟入口禁止网络。它不是生产网络沙箱，生产端口仍由接收方宿主实现。
const deny = () => { throw new Error('offline_network_forbidden'); };
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = deny;
  module.get = deny;
}
require('node:net').Socket.prototype.connect = deny;
require('node:net').connect = deny;
require('node:net').createConnection = deny;
require('node:tls').connect = deny;
require('node:dgram').createSocket = deny;

