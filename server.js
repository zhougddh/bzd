/**
 * 深圳子熙物流管理有限公司 - 实时定位后端服务
 * 
 * 功能：
 * 1. 接收司机端的GPS位置数据（WebSocket）
 * 2. 实时转发给管理后台（WebSocket广播）
 * 3. HTTP备用接口（REST API）
 * 4. 静态文件服务（前端页面）
 * 
 * 使用方法：
 *   1. 安装依赖：npm install
 *   2. 启动服务：node server.js
 *   3. 访问管理后台：http://localhost:3000
 *   4. 访问司机端：http://localhost:3000/driver.html
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================
// 配置
// ============================================================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ============================================================
// 数据存储（内存中，生产环境建议使用Redis/数据库）
// ============================================================
const clients = new Map();     // WebSocket客户端连接 {wsId: {type, ws}}
const drivers = new Map();     // 在线司机 {driverId: {name, phone, password, lastLocation, wsId}}
const driverAccounts = new Map(); // 司机账号列表 {driverId: {name, phone, password, vehicleNo}}
const orders = new Map();        // 订单列表 {orderId: {id, type, from, to, driverId, driverName, status, createdAt, completedAt}}
let wsIdCounter = 0;            // WebSocket连接ID计数器

// 初始化默认司机账号
driverAccounts.set('yubaohua', {
    driverId: 'yubaohua',
    name: '于保华',
    phone: '18165730627',
    password: '123456',
    vehicleNo: '粤B·12345'
});

console.log('============================================');
console.log('  深圳子熙物流管理有限公司 - 实时定位服务');
console.log('============================================');

// ============================================================
// HTTP服务器（同时处理静态文件和API请求）
// ============================================================
const server = http.createServer((req, res) => {
    // CORS设置
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // API路由
    if (url.pathname === '/api/location' && req.method === 'POST') {
        handleLocationAPI(req, res);
        return;
    }
    
    if (url.pathname === '/api/drivers') {
        if (req.method === 'GET') {
            handleGetDrivers(req, res);
        } else if (req.method === 'POST') {
            handleAddDriver(req, res);
        }
        return;
    }
    
    if (url.pathname.startsWith('/api/drivers/')) {
        const parts = url.pathname.split('/');
        const driverId = parts[3];
        if (req.method === 'DELETE') {
            handleDeleteDriver(req, res, driverId);
            return;
        }
    }
    
    if (url.pathname === '/api/drivers/login' && req.method === 'POST') {
        handleDriverLogin(req, res);
        return;
    }
    
    if (url.pathname === '/api/drivers/list') {
        handleGetDriverList(req, res);
        return;
    }
    
    // 在线人员查询
    if (url.pathname === '/api/online') {
        handleGetOnlineUsers(req, res);
        return;
    }
    
    // 订单API
    if (url.pathname === '/api/orders') {
        if (req.method === 'GET') {
            handleGetOrders(req, res);
        } else if (req.method === 'POST') {
            handleCreateOrder(req, res);
        }
        return;
    }
    
    if (url.pathname.startsWith('/api/orders/')) {
        const parts = url.pathname.split('/');
        const orderId = parts[3];
        if (req.method === 'DELETE') {
            handleDeleteOrder(req, res, orderId);
            return;
        }
        if (req.method === 'PUT') {
            handleUpdateOrder(req, res, orderId);
            return;
        }
    }
    
    if (url.pathname === '/api/health') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            status: 'ok',
            onlineDrivers: drivers.size,
            connectedClients: clients.size,
            uptime: process.uptime()
        }));
        return;
    }
    
    // 静态文件服务
    serveStaticFile(req, res, url.pathname);
});

// ============================================================
// 静态文件服务
// ============================================================
function serveStaticFile(req, res, pathname) {
    if (pathname === '/') {
        pathname = '/index.html';
    }
    
    if (pathname === '/driver' || pathname === '/driver.html') {
        pathname = '/driver.html';
    }
    
    if (pathname === '/driver/login' || pathname === '/driver/login.html') {
        pathname = '/driver_login.html';
    }
    
    const filePath = path.join(__dirname, pathname);
    const extname = path.extname(filePath);
    
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
    };
    
    const contentType = mimeTypes[extname] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('500 Internal Server Error');
            }
            return;
        }
        
        res.writeHead(200, {'Content-Type': contentType});
        res.end(data);
    });
}

// ============================================================
// HTTP API - 接收位置上报
// ============================================================
function handleLocationAPI(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            
            // 记录位置
            const driverId = data.driverId;
            if (driverId) {
                const driverInfo = drivers.get(driverId) || {};
                driverInfo.name = data.name || driverInfo.name;
                driverInfo.phone = data.phone || driverInfo.phone;
                driverInfo.lastLocation = {
                    lat: data.lat,
                    lng: data.lng,
                    accuracy: data.accuracy,
                    speed: data.speed,
                    address: data.address,
                    timestamp: data.timestamp || new Date().toLocaleString('zh-CN')
                };
                driverInfo.lastUpdate = Date.now();
                drivers.set(driverId, driverInfo);
                
                console.log(`[HTTP] 收到位置上报 - ${data.name}(${driverId}): ${data.lat}, ${data.lng}`);
            }
            
            // 转发给所有管理后台客户端
            broadcastToAdmins(data);
            
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'ok', message: '位置已接收'}));
        } catch(e) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'error', message: '无效的数据格式'}));
        }
    });
}

// ============================================================
// HTTP API - 获取在线司机列表
// ============================================================
function handleGetDrivers(req, res) {
    const driverList = [];
    drivers.forEach((info, id) => {
        driverList.push({
            driverId: id,
            name: info.name,
            phone: info.phone,
            online: info.wsId !== undefined,
            lastLocation: info.lastLocation,
            lastUpdate: info.lastUpdate ? new Date(info.lastUpdate).toLocaleString('zh-CN') : '-'
        });
    });
    
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({drivers: driverList}));
}

// ============================================================
// HTTP API - 添加司机账号
// ============================================================
function handleAddDriver(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            
            if (!data.name || !data.phone || !data.password) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 'error', message: '缺少必填字段（姓名、手机号、密码）'}));
                return;
            }
            
            const driverId = data.driverId || data.phone.replace(/\D/g, '');
            
            if (driverAccounts.has(driverId)) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 'error', message: '司机账号已存在'}));
                return;
            }
            
            driverAccounts.set(driverId, {
                driverId: driverId,
                name: data.name,
                phone: data.phone,
                password: data.password,
                vehicleNo: data.vehicleNo || ''
            });
            
            console.log(`[API] 添加司机账号: ${data.name}(${driverId})`);
            
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'ok', message: '司机账号添加成功', driverId: driverId}));
        } catch(e) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'error', message: '无效的数据格式'}));
        }
    });
}

// ============================================================
// HTTP API - 删除司机账号
// ============================================================
function handleDeleteDriver(req, res, driverId) {
    if (!driverId) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'error', message: '司机ID不能为空'}));
        return;
    }
    
    if (!driverAccounts.has(driverId)) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'error', message: '司机账号不存在'}));
        return;
    }
    
    const info = driverAccounts.get(driverId);
    driverAccounts.delete(driverId);
    
    if (drivers.has(driverId)) {
        const driverInfo = drivers.get(driverId);
        if (driverInfo.wsId) {
            removeClient(driverInfo.wsId);
        }
        drivers.delete(driverId);
    }
    
    console.log(`[API] 删除司机账号: ${info.name}(${driverId})`);
    
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok', message: '司机账号删除成功'}));
}

// ============================================================
// HTTP API - 司机登录验证
// ============================================================
function handleDriverLogin(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            
            if (!data.phone || !data.password) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 'error', message: '手机号或密码不能为空'}));
                return;
            }
            
            const driverId = data.phone.replace(/\D/g, '');
            const account = driverAccounts.get(driverId);
            
            if (!account || account.password !== data.password) {
                res.writeHead(401, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 'error', message: '手机号或密码错误'}));
                return;
            }
            
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                status: 'ok',
                message: '登录成功',
                driver: {
                    driverId: account.driverId,
                    name: account.name,
                    phone: account.phone,
                    vehicleNo: account.vehicleNo
                }
            }));
        } catch(e) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'error', message: '无效的数据格式'}));
        }
    });
}

// ============================================================
// HTTP API - 获取司机账号列表（所有账号，包括离线）
// ============================================================
function handleGetDriverList(req, res) {
    const driverList = [];
    driverAccounts.forEach((account, id) => {
        const onlineInfo = drivers.get(id);
        driverList.push({
            driverId: id,
            name: account.name,
            phone: account.phone,
            vehicleNo: account.vehicleNo,
            online: onlineInfo && onlineInfo.wsId !== undefined,
            lastLocation: onlineInfo ? onlineInfo.lastLocation : null,
            lastUpdate: onlineInfo && onlineInfo.lastUpdate ? new Date(onlineInfo.lastUpdate).toLocaleString('zh-CN') : '-'
        });
    });
    
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({drivers: driverList}));
}

// ============================================================
// HTTP API - 获取在线人员
// ============================================================
function handleGetOnlineUsers(req, res) {
    const onlineUsers = [];
    
    // 在线司机
    drivers.forEach((info, id) => {
        if (info.wsId !== undefined) {
            onlineUsers.push({
                type: 'driver',
                id: id,
                name: info.name,
                phone: info.phone,
                vehicleNo: driverAccounts.get(id)?.vehicleNo || '',
                lastLocation: info.lastLocation,
                onlineAt: new Date(info.lastUpdate || Date.now()).toLocaleString('zh-CN')
            });
        }
    });
    
    // 在线管理后台
    clients.forEach((client, wsId) => {
        if (client.type === 'admin') {
            onlineUsers.push({
                type: 'admin',
                id: wsId,
                name: '管理后台',
                onlineAt: new Date().toLocaleString('zh-CN')
            });
        }
    });
    
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({online: onlineUsers, count: onlineUsers.length}));
}

// ============================================================
// HTTP API - 获取订单列表
// ============================================================
function handleGetOrders(req, res) {
    const orderList = [];
    orders.forEach((order, id) => {
        orderList.push(order);
    });
    
    // 按创建时间倒序
    orderList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({orders: orderList}));
}

// ============================================================
// HTTP API - 创建订单
// ============================================================
function handleCreateOrder(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            
            if (!data.type || !data.from || !data.to) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 'error', message: '缺少必填字段（类型、发货地、收货地）'}));
                return;
            }
            
            const orderId = 'ORD' + Date.now();
            const order = {
                id: orderId,
                type: data.type,           // 'delivery' 送货, 'pickup' 取货
                from: data.from,           // 发货地
                to: data.to,               // 收货地
                cargo: data.cargo || '',   // 货物信息
                weight: data.weight || '', // 重量
                driverId: data.driverId || '',
                driverName: data.driverName || '',
                status: data.driverId ? 'assigned' : 'pending', // pending待派单, assigned已派单, inProgress进行中, completed已完成
                createdAt: new Date().toLocaleString('zh-CN'),
                completedAt: ''
            };
            
            orders.set(orderId, order);
            console.log(`[API] 创建订单: ${orderId} - ${data.type} - ${data.from} → ${data.to}`);
            
            // 广播给所有管理后台
            broadcastToAdmins({
                type: 'order_created',
                order: order
            });
            
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'ok', message: '订单创建成功', order: order}));
        } catch(e) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'error', message: '无效的数据格式'}));
        }
    });
}

// ============================================================
// HTTP API - 删除订单
// ============================================================
function handleDeleteOrder(req, res, orderId) {
    if (!orderId) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'error', message: '订单ID不能为空'}));
        return;
    }
    
    if (!orders.has(orderId)) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'error', message: '订单不存在'}));
        return;
    }
    
    const order = orders.get(orderId);
    orders.delete(orderId);
    
    console.log(`[API] 删除订单: ${orderId}`);
    
    // 广播给所有管理后台
    broadcastToAdmins({
        type: 'order_deleted',
        orderId: orderId
    });
    
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok', message: '订单删除成功'}));
}

// ============================================================
// HTTP API - 更新订单状态
// ============================================================
function handleUpdateOrder(req, res, orderId) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            if (!orders.has(orderId)) {
                res.writeHead(404, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 'error', message: '订单不存在'}));
                return;
            }
            
            const data = JSON.parse(body);
            const order = orders.get(orderId);
            
            if (data.driverId !== undefined) order.driverId = data.driverId;
            if (data.driverName !== undefined) order.driverName = data.driverName;
            if (data.status !== undefined) {
                order.status = data.status;
                if (data.status === 'completed') {
                    order.completedAt = new Date().toLocaleString('zh-CN');
                }
            }
            
            orders.set(orderId, order);
            
            // 广播更新
            broadcastToAdmins({
                type: 'order_updated',
                order: order
            });
            
            // 如果是派单，通知指定司机
            if (data.driverId && drivers.has(data.driverId)) {
                const driverInfo = drivers.get(data.driverId);
                if (driverInfo.wsId) {
                    sendToClient(driverInfo.wsId, {
                        type: 'order_assigned',
                        order: order
                    });
                }
            }
            
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'ok', message: '订单更新成功', order: order}));
        } catch(e) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({status: 'error', message: '无效的数据格式'}));
        }
    });
}

// ============================================================
// WebSocket升级处理
// ============================================================
server.on('upgrade', (req, socket) => {
    // 简单的WebSocket协议握手
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.destroy();
        return;
    }
    
    const acceptKey = generateWebSocketAccept(key);
    
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n'
    );
    
    const wsId = ++wsIdCounter;
    let buffer = Buffer.alloc(0);
    
    // 保存WebSocket引用
    const wsRef = {
        type: 'unknown', // 'driver' 或 'admin'
        socket: socket,
        alive: true,
        pingTimer: null
    };
    clients.set(wsId, wsRef);
    
    console.log(`[WS] 新连接 #${wsId}`);
    
    // 心跳检测
    wsRef.pingTimer = setInterval(() => {
        if (!wsRef.alive) {
            removeClient(wsId);
            return;
        }
        wsRef.alive = false;
        sendWebSocketFrame(socket, Buffer.from([0x89, 0x00])); // Ping
    }, 30000);
    
    // 接收消息
    socket.on('data', (data) => {
        wsRef.alive = true;
        
        // 解析WebSocket帧
        try {
            const message = parseWebSocketFrame(data);
            if (message) {
                handleWebSocketMessage(wsId, wsRef, message);
            }
        } catch(e) {
            // 忽略解析错误
        }
    });
    
    socket.on('close', () => {
        console.log(`[WS] 连接断开 #${wsId}`);
        removeClient(wsId);
    });
    
    socket.on('error', (err) => {
        console.error(`[WS] 错误 #${wsId}:`, err.message);
        removeClient(wsId);
    });
});

// ============================================================
// WebSocket帧解析（简化版，支持文本帧）
// ============================================================
function parseWebSocketFrame(data) {
    if (data[0] === undefined) return null;
    
    const firstByte = data[0];
    const opcode = firstByte & 0x0F;
    
    // Pong响应
    if (opcode === 0xA) return null;
    
    // 只处理文本帧
    if (opcode !== 0x1) return null;
    
    const secondByte = data[1];
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;
    
    if (payloadLength === 126) {
        payloadLength = data.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        payloadLength = Number(data.readBigUInt64BE(2));
        offset = 10;
    }
    
    if (masked) {
        offset += 4; // 跳过mask key
    }
    
    const payload = data.slice(offset, offset + payloadLength);
    
    try {
        return JSON.parse(payload.toString('utf8'));
    } catch(e) {
        return null;
    }
}

// ============================================================
// 发送WebSocket帧
// ============================================================
function sendWebSocketFrame(socket, data) {
    try {
        if (socket.writableEnded) return;
        
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const length = buf.length;
        
        let header;
        if (length < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x81; // 文本帧
            header[1] = length;
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        
        socket.write(Buffer.concat([header, buf]));
    } catch(e) {
        // 发送失败，忽略
    }
}

// ============================================================
// 处理WebSocket消息
// ============================================================
function handleWebSocketMessage(wsId, wsRef, message) {
    if (!message || !message.type) return;
    
    switch(message.type) {
        case 'register':
            // 客户端注册身份
            wsRef.type = message.role || 'unknown';
            console.log(`[WS] #${wsId} 注册为 ${wsRef.type}: ${message.name || ''}`);
            
            if (wsRef.type === 'driver') {
                // 司机上线
                const driverId = message.driverId;
                const existing = drivers.get(driverId);
                if (existing && existing.wsId && existing.wsId !== wsId) {
                    // 踢掉旧连接
                    removeClient(existing.wsId);
                }
                
                drivers.set(driverId, {
                    name: message.name,
                    phone: message.phone,
                    wsId: wsId,
                    lastLocation: null,
                    lastUpdate: Date.now()
                });
                
                // 通知所有管理后台
                broadcastToAdmins({
                    type: 'driver_online',
                    driverId: driverId,
                    name: message.name,
                    phone: message.phone
                });
                
                console.log(`[WS] 司机上线: ${message.name}(${driverId})`);
            }
            break;
            
        case 'location':
            // 位置更新
            const driverId = message.driverId;
            if (driverId) {
                const driverInfo = drivers.get(driverId) || {};
                driverInfo.name = message.name || driverInfo.name;
                driverInfo.phone = message.phone || driverInfo.phone;
                driverInfo.wsId = wsId;
                driverInfo.lastLocation = {
                    lat: message.lat,
                    lng: message.lng,
                    accuracy: message.accuracy,
                    speed: message.speed,
                    address: message.address,
                    timestamp: message.timestamp || new Date().toLocaleString('zh-CN')
                };
                driverInfo.lastUpdate = Date.now();
                drivers.set(driverId, driverInfo);
                
                // 转发给所有管理后台客户端
                broadcastToAdmins(message);
                
                console.log(`[WS] 位置更新 - ${message.name}: ${message.lat}, ${message.lng} (精度${message.accuracy}m)`);
            }
            break;
            
        case 'driver_online':
            // 司机上线消息
            const id = message.driverId;
            if (id) {
                const info = drivers.get(id) || {};
                info.name = message.name;
                info.phone = message.phone;
                info.wsId = wsId;
                info.lastUpdate = Date.now();
                drivers.set(id, info);
                
                broadcastToAdmins(message);
                console.log(`[WS] 司机上线: ${message.name}(${id})`);
            }
            break;
    }
}

// ============================================================
// 广播消息给所有管理后台客户端
// ============================================================
function broadcastToAdmins(message) {
    const data = JSON.stringify(message);
    clients.forEach((client, id) => {
        if (client.type === 'admin' && client.socket && !client.socket.writableEnded) {
            sendWebSocketFrame(client.socket, data);
        }
    });
}

// ============================================================
// 移除客户端连接
// ============================================================
function removeClient(wsId) {
    const client = clients.get(wsId);
    if (!client) return;
    
    // 清除心跳定时器
    if (client.pingTimer) {
        clearInterval(client.pingTimer);
    }
    
    // 如果是司机断开连接
    if (client.type === 'driver') {
        drivers.forEach((info, driverId) => {
            if (info.wsId === wsId) {
                info.wsId = undefined;
                console.log(`[WS] 司机离线: ${info.name}(${driverId})`);
                
                // 通知管理后台
                broadcastToAdmins({
                    type: 'driver_offline',
                    driverId: driverId,
                    name: info.name
                });
            }
        });
    }
    
    // 关闭socket
    try {
        client.socket.end();
    } catch(e) {}
    
    clients.delete(wsId);
    console.log(`[WS] 已移除连接 #${wsId}，当前连接数：${clients.size}`);
}

// ============================================================
// WebSocket握手中的Sec-WebSocket-Accept计算
// ============================================================
function generateWebSocketAccept(key) {
    const crypto = require('crypto');
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    return crypto.createHash('sha1')
        .update(key + GUID)
        .digest('base64');
}

// ============================================================
// 启动服务器
// ============================================================
server.listen(PORT, HOST, () => {
    console.log(`\n服务已启动！`);
    console.log(`  管理后台：http://localhost:${PORT}`);
    console.log(`  司机端：  http://localhost:${PORT}/driver`);
    console.log(`  API健康检查：http://localhost:${PORT}/api/health`);
    console.log(`\n提示：请在HTML文件中配置高德地图Key以启用地图功能`);
    console.log(`      高德Key申请：https://console.amap.com/dev/key/app\n`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('\n正在关闭服务器...');
    clients.forEach((_, wsId) => removeClient(wsId));
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    clients.forEach((_, wsId) => removeClient(wsId));
    server.close(() => process.exit(0));
});
