/**
 * 泥研製所 製造 App — Cloudflare Pages Function
 * 取代原本的 Google Apps Script 後端，改讀寫 D1（與出貨 App 共用 niyan-db）。
 * 路由：POST /api   （前端 API_URL 設為 '/api'）
 * D1 綁定名稱：DB
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try { body = JSON.parse(await request.text()); } catch (_) {}
  const action = body.action || 'getAll';
  const payload = body.payload || {};
  try {
    const data = await handle(env.DB, action, payload);
    return json({ ok: true, data });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

/* ---------- 工具 ---------- */
function json(o) {
  return new Response(JSON.stringify(o), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
let _seq = 0;
function newId(prefix) {
  return prefix + Date.now() + '_' + ((_seq++ % 1000) * 1000 + Math.floor(Math.random() * 1000)) % 1000;
}
function tw(offsetSlice) {              // 台灣時間
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, offsetSlice).replace('T', ' ');
}
const now = () => tw(19);               // yyyy-MM-dd HH:mm:ss
const today = () => tw(10);             // yyyy-MM-dd
const bool2text = (v) => (v ? '是' : '');
const text2bool = (v) => v === '是' || v === true || v === 'TRUE';

/* ---------- 分派 ---------- */
async function handle(DB, action, p) {
  switch (action) {
    case 'getAll':          return getAll(DB);
    case 'addOrder':        return addOrder(DB, p);
    case 'addOrderQty':     return addOrderQty(DB, p);
    case 'setOrderDone':    return setOrderDone(DB, p);
    case 'setOrderHidden':  return setOrderHidden(DB, p);
    case 'purgeOrders':     return purgeOrders(DB, p);
    case 'addMakeLog':      return addLog(DB, 'mfg_records', '完成日期', '製作師傅', p);
    case 'addGrindLog':     return addLog(DB, 'grind_records', '研磨日期', '研磨人員', p);
    case 'addWashLog':      return addLog(DB, 'wash_records', '清洗日期', '清洗人員', p);
    case 'deleteMakeLog':   return deleteLog(DB, 'mfg_records', p);
    case 'deleteGrindLog':  return deleteLog(DB, 'grind_records', p);
    case 'deleteWashLog':   return deleteLog(DB, 'wash_records', p);
    case 'addOption':       return addOption(DB, p);
    case 'deleteOption':    return deleteOption(DB, p);
    default: throw new Error('unknown action: ' + action);
  }
}

/* ---------- 讀取 ---------- */
async function getAll(DB) {
  const [ord, mk, gr, ws, st] = await Promise.all([
    DB.prepare('SELECT * FROM orders').all(),
    DB.prepare('SELECT * FROM mfg_records').all(),
    DB.prepare('SELECT * FROM grind_records').all(),
    DB.prepare('SELECT * FROM wash_records').all(),
    DB.prepare('SELECT "類型","值" FROM settings WHERE "類型" IN (\'廠商\',\'品項\',\'款式\',\'顏色\',\'大小\')').all(),
  ]);

  const orders = (ord.results || []).map(o => ({
    id: o['ID'],
    orderDate: o['下單日期'] || '',
    vendor: o['廠商'] || '',
    item: o['品項'] || '',
    color: o['顏色'] || '',
    size: o['大小'] || '',
    quantity: Number(o['數量']) || 0,
    dueDate: o['交期'] || '',
    urgent: text2bool(o['急單']),
    createdAt: o['建立時間'] || '',
    style: o['款式'] || '',
    note: o['備註'] || '',
    done: text2bool(o['已完成']),
    doneDate: o['完成日期'] || '',
    hidden: text2bool(o['已隱藏']),
  }));

  const mapLog = (dateCol, personCol) => (r) => ({
    id: r['ID'],
    orderId: r['訂單ID'],
    date: r[dateCol] || '',
    person: r[personCol] || '',
    quantity: Number(r['數量']) || 0,
    createdAt: r['建立時間'] || '',
    scrap: Number(r['報廢']) || 0,
  });
  const makeLogs = (mk.results || []).map(mapLog('完成日期', '製作師傅'));
  const grindLogs = (gr.results || []).map(mapLog('研磨日期', '研磨人員'));
  const washLogs = (ws.results || []).map(mapLog('清洗日期', '清洗人員'));

  const byType = { '廠商': [], '品項': [], '款式': [], '顏色': [], '大小': [] };
  (st.results || []).forEach(r => {
    const t = String(r['類型'] || '').trim();
    const v = String(r['值'] || '').trim();
    if (byType[t] && v) byType[t].push(v);
  });

  return {
    orders, makeLogs, grindLogs, washLogs,
    customVendors: byType['廠商'],
    customItems: byType['品項'],
    customStyles: byType['款式'],
    customColors: byType['顏色'],
    customSizes: byType['大小'],
  };
}

/* ---------- 訂單 ---------- */
async function addOrder(DB, p) {
  const id = newId('O'), n = now();
  await DB.prepare(
    'INSERT INTO orders ("ID","下單日期","廠商","品項","顏色","大小","數量","交期","急單","建立時間","款式","備註","已完成","完成日期") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    id, p.orderDate || '', p.vendor || '', p.item || '', p.color || '', p.size || '',
    Number(p.quantity) || 0, p.dueDate || '', bool2text(p.urgent), n, p.style || '', p.note || '', '', ''
  ).run();
  return { id };
}
async function addOrderQty(DB, p) {
  const row = await DB.prepare('SELECT "數量" q FROM orders WHERE "ID"=?').bind(p.id).first();
  const quantity = (row ? Number(row.q) || 0 : 0) + (Number(p.delta) || 0);
  await DB.prepare('UPDATE orders SET "數量"=? WHERE "ID"=?').bind(quantity, p.id).run();
  return { quantity };
}
async function setOrderDone(DB, p) {
  await DB.prepare('UPDATE orders SET "已完成"=?, "完成日期"=? WHERE "ID"=?')
    .bind(bool2text(p.done), p.done ? (p.doneDate || today()) : '', p.id).run();
  return { id: p.id };
}
async function setOrderHidden(DB, p) {
  await DB.prepare('UPDATE orders SET "已隱藏"=? WHERE "ID"=?').bind(bool2text(p.hidden), p.id).run();
  return { id: p.id, hidden: !!p.hidden };
}
async function purgeOrders(DB, p) {
  const ids = Array.isArray(p.ids) ? p.ids : [];
  if (!ids.length) return { ok: true, count: 0 };
  const ph = ids.map(() => '?').join(',');
  await DB.batch([
    DB.prepare(`DELETE FROM orders WHERE "ID" IN (${ph})`).bind(...ids),
    DB.prepare(`DELETE FROM mfg_records WHERE "訂單ID" IN (${ph})`).bind(...ids),
    DB.prepare(`DELETE FROM grind_records WHERE "訂單ID" IN (${ph})`).bind(...ids),
    DB.prepare(`DELETE FROM wash_records WHERE "訂單ID" IN (${ph})`).bind(...ids),
  ]);
  return { ok: true, count: ids.length };
}

/* ---------- 製造/研磨/清洗紀錄 ---------- */
async function addLog(DB, table, dateCol, personCol, p) {
  const id = newId(table === 'mfg_records' ? 'M' : table === 'grind_records' ? 'G' : 'W');
  await DB.prepare(
    `INSERT INTO ${table} ("ID","訂單ID","${dateCol}","${personCol}","數量","建立時間","報廢") VALUES (?,?,?,?,?,?,?)`
  ).bind(id, p.orderId || '', p.date || today(), p.person || '', Number(p.quantity) || 0, now(), Number(p.scrap) || 0).run();
  return { id };
}
async function deleteLog(DB, table, p) {
  await DB.prepare(`DELETE FROM ${table} WHERE "ID"=?`).bind(p.id).run();
  return { id: p.id };
}

/* ---------- 自訂選項（廠商/品項/款式/顏色/大小） ---------- */
async function addOption(DB, p) {
  const type = String(p.type || '').trim();
  const value = String(p.value || '').trim();
  if (!type || !value) throw new Error('type 與 value 都不能為空');
  const dup = await DB.prepare('SELECT 1 FROM settings WHERE "類型"=? AND "值"=? LIMIT 1').bind(type, value).first();
  if (dup) return { ok: true, duplicated: true };
  await DB.prepare('INSERT INTO settings ("類型","值") VALUES (?,?)').bind(type, value).run();
  return { ok: true };
}
async function deleteOption(DB, p) {
  const type = String(p.type || '').trim();
  const value = String(p.value || '').trim();
  if (!type || !value) throw new Error('type 與 value 都不能為空');
  await DB.prepare('DELETE FROM settings WHERE "類型"=? AND "值"=?').bind(type, value).run();
  return { ok: true };
}
