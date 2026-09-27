/**
 * 上商淘 · 上海商学院二手交易平台后端服务
 * 技术栈：Node.js + Express + MySQL + JWT
 *
 * 启动：
 *   1. mysql -u root -p < server/schema.sql
 *   2. cd server && npm install
 *   3. npm start   (默认监听 3000 端口)
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===== 数据库连接 =====
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '123456',
  database: process.env.DB_NAME || 'shangtao',
  waitForConnections: true,
  connectionLimit: 10
});

const JWT_SECRET = process.env.JWT_SECRET || 'shangtao_secret_2026';

// ===== 中间件：JWT 鉴权 =====
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ code: 401, msg: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, msg: '登录已过期' });
  }
}
// 审核员鉴权
function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 1) return res.status(403).json({ code: 403, msg: '无审核权限' });
    next();
  });
}

// ===== 文件上传 =====
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// 独立图片上传接口：图片持久保存到 server/uploads/，返回可长期引用的 URL
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ code: 1, msg: '未收到文件' });
  res.json({ code: 0, msg: '上传成功', url: '/uploads/' + req.file.filename });
});

// ============================================================
// 认证模块
// ============================================================

// 发送验证码（演示：固定返回 1234）
app.post('/api/auth/send-code', async (req, res) => {
  const { phone } = req.body;
  if (!/^1\d{10}$/.test(phone || '')) {
    return res.json({ code: 1, msg: '手机号格式错误' });
  }
  // TODO: 对接短信服务商，此处演示固定验证码
  res.json({ code: 0, msg: '验证码已发送', data: { code: '1234' } });
});

// 登录 / 注册
app.post('/api/auth/login', async (req, res) => {
  const { phone, code } = req.body;
  if (!/^1\d{10}$/.test(phone || '')) {
    return res.json({ code: 1, msg: '手机号格式错误' });
  }
  if (!code || code.length < 4) {
    return res.json({ code: 1, msg: '验证码错误' });
  }

  let [rows] = await pool.query('SELECT * FROM `user` WHERE phone = ?', [phone]);
  let user;
  if (rows.length === 0) {
    // 首次登录自动注册
    const [r] = await pool.query(
      'INSERT INTO `user` (phone, password, nickname) VALUES (?,?,?)',
      [phone, '', ('上商用户' + phone.slice(-4))]
    );
    user = { id: r.insertId, role: 0, nickname: '上商用户' + phone.slice(-4) };
  } else {
    user = rows[0];
  }

  const token = jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({
    code: 0,
    msg: '登录成功',
    data: {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname,
        avatar: user.avatar,
        role: user.role
      }
    }
  });
});

// ============================================================
// 商品模块
// ============================================================

// 商品列表（分类 / 关键词 / 排序）
app.get('/api/products', async (req, res) => {
  const { category, keyword, sort } = req.query;
  const where = ["p.status = 1"];   // 仅已上架
  const params = [];
  if (category && category !== 'all') {
    where.push('p.category = ?');
    params.push(category);
  }
  if (keyword) {
    where.push('(p.title LIKE ? OR p.description LIKE ?)');
    params.push('%' + keyword + '%', '%' + keyword + '%');
  }
  let orderBy = 'p.created_at DESC';
  if (sort === 'price') orderBy = 'p.price ASC';
  if (sort === 'new') orderBy = 'p.created_at DESC';
  if (sort === 'near') orderBy = 'p.location ASC';

  const [rows] = await pool.query(
    `SELECT p.*, u.nickname AS seller_name
     FROM product p LEFT JOIN \`user\` u ON p.seller_id = u.id
     WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`,
    params
  );
  res.json({ code: 0, data: rows });
});

// 商品详情
app.get('/api/products/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.*, u.nickname AS seller_name, u.avatar AS seller_avatar
     FROM product p LEFT JOIN \`user\` u ON p.seller_id = u.id
     WHERE p.id = ?`,
    [req.params.id]
  );
  if (rows.length === 0) return res.json({ code: 1, msg: '商品不存在' });
  await pool.query('UPDATE product SET view_count = view_count + 1 WHERE id = ?', [req.params.id]);
  res.json({ code: 0, data: rows[0] });
});

// 发布商品
app.post('/api/products/publish', auth, upload.array('images', 9), async (req, res) => {
  const { title, price, category, description, location } = req.body;
  if (!title || !price) return res.json({ code: 1, msg: '参数不完整' });

  const images = (req.files || []).map(f => '/uploads/' + f.filename);
  const [r] = await pool.query(
    `INSERT INTO product
     (seller_id, category, title, description, price, cover_image, location, status)
     VALUES (?,?,?,?,?,?,?,0)`,
    [req.user.id, category || '其他', title, description || '', price,
     images[0] || '', location || '奉贤校区']
  );
  // 保存多图
  for (let i = 1; i < images.length; i++) {
    await pool.query(
      'INSERT INTO product_image (product_id, image_url, sort) VALUES (?,?,?)',
      [r.insertId, images[i], i]
    );
  }
  res.json({ code: 0, msg: '发布成功，等待审核', data: { id: r.insertId } });
});

// ============================================================
// 审核模块（审核员）
// ============================================================

// 审核列表（按状态）
app.get('/api/admin/products', adminAuth, async (req, res) => {
  const { status = 0 } = req.query;
  const [rows] = await pool.query(
    `SELECT p.*, u.nickname AS seller_name
     FROM product p LEFT JOIN \`user\` u ON p.seller_id = u.id
     WHERE p.status = ? ORDER BY p.created_at DESC`,
    [status]
  );
  res.json({ code: 0, data: rows });
});

// 审核通过 / 驳回
app.post('/api/products/:id/audit', adminAuth, async (req, res) => {
  const { approved, reason } = req.body;
  const productId = req.params.id;

  const [rows] = await pool.query('SELECT * FROM product WHERE id = ?', [productId]);
  if (rows.length === 0) return res.json({ code: 1, msg: '商品不存在' });
  const product = rows[0];

  const status = approved ? 1 : 2;
  await pool.query(
    `UPDATE product SET status = ?, reject_reason = ?, auditor_id = ?, audit_time = NOW()
     WHERE id = ?`,
    [status, approved ? '' : (reason || '不符合平台规范'), req.user.id, productId]
  );

  // 写入通知（与状态更新同一流程）
  await pool.query(
    `INSERT INTO notification (user_id, type, title, content, related_id)
     VALUES (?,?,?,?,?)`,
    [
      product.seller_id,
      approved ? 'approve' : 'reject',
      approved ? '审核通过' : '审核驳回',
      approved
        ? `您的商品「${product.title}」已通过审核，已成功上架`
        : `您的商品「${product.title}」被驳回：${reason || '不符合平台规范'}`,
      productId
    ]
  );

  res.json({ code: 0, msg: approved ? '已通过审核' : '已驳回' });
});

// ============================================================
// 订单模块
// ============================================================

// 创建订单
app.post('/api/orders/create', auth, async (req, res) => {
  const { productId, tradeType, tradePlace } = req.body;
  const [rows] = await pool.query('SELECT * FROM product WHERE id = ?', [productId]);
  if (rows.length === 0) return res.json({ code: 1, msg: '商品不存在' });
  const product = rows[0];
  if (product.status !== 1) return res.json({ code: 1, msg: '商品已不可购买' });

  const orderNo = 'ST' + Date.now() + Math.floor(Math.random() * 1000);
  const [r] = await pool.query(
    `INSERT INTO \`order\`
     (order_no, buyer_id, seller_id, product_id, price, trade_type, trade_place, status)
     VALUES (?,?,?,?,?,?,?,0)`,
    [orderNo, req.user.id, product.seller_id, productId, product.price,
     tradeType || '自提', tradePlace || '奉贤校区一食堂门口']
  );
  // 商品置为已售
  await pool.query('UPDATE product SET status = 3 WHERE id = ?', [productId]);
  // 通知买卖双方
  await pool.query(
    `INSERT INTO notification (user_id, type, title, content, related_id) VALUES (?,?,?,?,?)`,
    [product.seller_id, 'order', '新订单', `您的商品「${product.title}」有新的买家订单`, r.insertId]
  );

  res.json({ code: 0, msg: '下单成功', data: { orderNo } });
});

// ============================================================
// 通知模块
// ============================================================

// 我的通知 + 未读数
app.get('/api/notifications', auth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM notification WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id]
  );
  const [cnt] = await pool.query(
    'SELECT COUNT(*) AS n FROM notification WHERE user_id = ? AND is_read = 0',
    [req.user.id]
  );
  res.json({ code: 0, data: { list: rows, unread: cnt[0].n } });
});

// 全部已读
app.post('/api/notifications/read', auth, async (req, res) => {
  await pool.query(
    'UPDATE notification SET is_read = 1 WHERE user_id = ?',
    [req.user.id]
  );
  res.json({ code: 0, msg: '已全部已读' });
});

// ============================================================
// 消息模块（实时通信）
// ============================================================

// 在线用户：userId -> Set<socketId>（支持同账号多端在线）
const onlineUsers = new Map();
function isUserOnline(uid) {
  const s = onlineUsers.get(Number(uid));
  return !!(s && s.size > 0);
}

// 会话约定：user_a_id < user_b_id，保证两人唯一会话
async function getConversationId(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const [rows] = await pool.query(
    'SELECT id FROM conversation WHERE user_a_id = ? AND user_b_id = ?', [lo, hi]);
  return rows.length ? rows[0].id : null;
}
async function getOrCreateConversation(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  let id = await getConversationId(lo, hi);
  if (id) return id;
  try {
    const [r] = await pool.query(
      'INSERT INTO conversation (user_a_id, user_b_id) VALUES (?,?)', [lo, hi]);
    return r.insertId;
  } catch (e) {
    // 并发插入撞唯一键时直接再查
    return await getConversationId(lo, hi);
  }
}

async function getUserBrief(uid) {
  const [rows] = await pool.query(
    'SELECT id, nickname, avatar, role FROM `user` WHERE id = ?', [uid]);
  return rows[0] || { id: uid, nickname: '用户' + uid, avatar: '', role: 0 };
}

// 落库 + 更新会话预览 + 实时投递
async function deliverMessage(senderId, receiverId, content) {
  const convId = await getOrCreateConversation(senderId, receiverId);
  const [r] = await pool.query(
    'INSERT INTO message (conversation_id, sender_id, receiver_id, content) VALUES (?,?,?,?)',
    [convId, senderId, receiverId, content]);
  await pool.query(
    'UPDATE conversation SET last_message = ?, updated_at = NOW() WHERE id = ?',
    [content.slice(0, 200), convId]);
  const sender = await getUserBrief(senderId);
  const msg = {
    id: r.insertId, conversationId: convId,
    from: sender, to: receiverId,
    content, createdAt: new Date().toISOString()
  };
  io.to('user:' + receiverId).emit('private_message', msg);
  return msg;
}

// 标记会话已读，并给发送方推已读回执
async function markConversationRead(convId, readerId, peerId) {
  if (!convId) return;
  const [r] = await pool.query(
    'UPDATE message SET is_read = 1 WHERE conversation_id = ? AND receiver_id = ? AND is_read = 0',
    [convId, readerId]);
  if (r.affectedRows > 0) {
    io.to('user:' + peerId).emit('messages_read', { peerId: readerId });
  }
}

// 改昵称
app.post('/api/auth/profile', auth, async (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || !nickname.trim()) return res.json({ code: 1, msg: '昵称不能为空' });
  await pool.query('UPDATE `user` SET nickname = ? WHERE id = ?', [nickname.trim().slice(0, 30), req.user.id]);
  res.json({ code: 0, msg: '已更新' });
});

// 搜索用户（昵称 / 手机号）
app.get('/api/users/search', auth, async (req, res) => {
  const kw = String(req.query.keyword || '').trim();
  if (!kw) return res.json({ code: 0, data: [] });
  const like = '%' + kw + '%';
  const [rows] = await pool.query(
    'SELECT id, nickname, avatar, college, phone, role FROM `user` WHERE id != ? AND (nickname LIKE ? OR phone LIKE ?) LIMIT 20',
    [req.user.id, like, like]);
  res.json({
    code: 0,
    data: rows.map(u => ({ ...u, online: isUserOnline(u.id) }))
  });
});

// 会话列表（对方信息 + 未读数 + 在线状态）
app.get('/api/conversations', auth, async (req, res) => {
  const uid = req.user.id;
  const [rows] = await pool.query(
    `SELECT c.id AS conversationId, c.last_message, c.updated_at,
            u.id AS peerId, u.nickname, u.avatar, u.role,
            (SELECT COUNT(*) FROM message m
              WHERE m.conversation_id = c.id AND m.receiver_id = ? AND m.is_read = 0) AS unread
     FROM conversation c
     JOIN \`user\` u ON u.id = IF(c.user_a_id = ?, c.user_b_id, c.user_a_id)
     WHERE c.user_a_id = ? OR c.user_b_id = ?
     ORDER BY c.updated_at DESC`,
    [uid, uid, uid, uid]);
  res.json({
    code: 0,
    data: rows.map(r => ({
      conversationId: r.conversationId,
      peerId: r.peerId,
      name: r.nickname,
      avatar: r.avatar || '',
      role: r.role,
      preview: r.last_message || '',
      updatedAt: r.updated_at,
      unread: r.unread,
      online: isUserOnline(r.peerId)
    }))
  });
});

// 历史消息（不存在会话时返回空数组，不创建空会话）+ 置已读
app.get('/api/messages/:peerId', auth, async (req, res) => {
  const uid = req.user.id;
  const peerId = Number(req.params.peerId);
  const convId = await getConversationId(uid, peerId);
  if (!convId) return res.json({ code: 0, data: [] });
  const [rows] = await pool.query(
    'SELECT id, sender_id AS senderId, receiver_id AS receiverId, content, is_read AS isRead, created_at AS createdAt FROM message WHERE conversation_id = ? ORDER BY id ASC LIMIT 500',
    [convId]);
  await markConversationRead(convId, uid, peerId);
  res.json({ code: 0, data: rows });
});

// REST 发消息（Socket 断开时的兜底，服务端仍会实时推送给对方）
app.post('/api/messages', auth, async (req, res) => {
  const { to, content } = req.body || {};
  const text = String(content || '').trim();
  if (!to || !text) return res.json({ code: 1, msg: '参数不完整' });
  if (text.length > 1000) return res.json({ code: 1, msg: '消息过长' });
  const msg = await deliverMessage(req.user.id, Number(to), text);
  res.json({ code: 0, data: { id: msg.id, createdAt: msg.createdAt } });
});

// 标记与某人的会话已读
app.post('/api/messages/read', auth, async (req, res) => {
  const peerId = Number((req.body || {}).peerId);
  if (!peerId) return res.json({ code: 1, msg: '参数不完整' });
  const convId = await getConversationId(req.user.id, peerId);
  await markConversationRead(convId, req.user.id, peerId);
  res.json({ code: 0, msg: 'ok' });
});

// 清空我的全部聊天记录（删除我参与的会话及消息）
app.post('/api/messages/clear-all', auth, async (req, res) => {
  const uid = req.user.id;
  const [convs] = await pool.query(
    'SELECT id FROM conversation WHERE user_a_id = ? OR user_b_id = ?', [uid, uid]);
  const ids = convs.map(c => c.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    await pool.query(`DELETE FROM message WHERE conversation_id IN (${ph})`, ids);
    await pool.query(`DELETE FROM conversation WHERE id IN (${ph})`, ids);
  }
  res.json({ code: 0, msg: '已清空' });
});

// ============================================================
// 前端静态文件托管（使 http://localhost:3000/ 可直接访问 H5 应用）
// 放在所有 API 路由之后，不影响 /api 接口
// ============================================================
app.use(express.static(path.join(__dirname, '..')));

// ============================================================
// 健康检查 + 启动（HTTP + Socket.IO 同端口）
// ============================================================
app.get('/api/health', (req, res) => res.json({ code: 0, msg: '上商淘服务运行中' }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6
});

// Socket 握手鉴权
io.use((socket, next) => {
  try {
    const token = (socket.handshake.auth || {}).token || '';
    const user = jwt.verify(token, JWT_SECRET);
    socket.userId = user.id;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const uid = socket.userId;
  socket.join('user:' + uid);
  if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
  onlineUsers.get(uid).add(socket.id);

  // 上线：告知本端当前在线列表，并广播上线状态
  socket.emit('presence_list',
    [...onlineUsers.keys()].map(id => ({ userId: id, online: true })));
  socket.broadcast.emit('presence_update', { userId: uid, online: true });

  // 私聊消息（带 ack 确认）
  socket.on('private_message', async (payload, ack) => {
    try {
      const to = Number((payload || {}).to);
      const text = String((payload || {}).content || '').trim();
      if (!to || !text) {
        if (typeof ack === 'function') ack({ code: 1, msg: '参数不完整' });
        return;
      }
      if (text.length > 1000) {
        if (typeof ack === 'function') ack({ code: 1, msg: '消息过长' });
        return;
      }
      const msg = await deliverMessage(uid, to, text);
      if (typeof ack === 'function') {
        ack({ code: 0, message: { id: msg.id, createdAt: msg.createdAt, conversationId: msg.conversationId } });
      }
    } catch (e) {
      console.error('private_message error:', e.message);
      if (typeof ack === 'function') ack({ code: 1, msg: '发送失败' });
    }
  });

  // 正在输入（透传）
  socket.on('typing', (payload) => {
    const to = Number((payload || {}).to);
    if (!to) return;
    io.to('user:' + to).emit('typing', { from: uid, typing: !!(payload || {}).typing });
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(uid);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(uid);
        socket.broadcast.emit('presence_update', { userId: uid, online: false });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('=================================');
  console.log('  上商淘后端服务已启动');
  console.log('  地址: http://localhost:' + PORT);
  console.log('=================================');
});
