'use strict';
require('dotenv').config();

const net      = require('net');
const mongoose = require('mongoose');
const Location = require('./models/Location');
const { parseLine, buildAck } = require('./parser');

const PORT        = parseInt(process.env.PORT || '5010', 10);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/di-stage';

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => { console.error('✗ MongoDB connection failed:', err.message); process.exit(1); });

// ─── Per-connection session state ─────────────────────────────────────────────
// Key: "<ip>:<port>",  Value: { imei, vehicleRegNo, loggedIn }
const sessions = new Map();

// ─── TCP Server ───────────────────────────────────────────────────────────────
const server = net.createServer(socket => {
  const connId  = `${socket.remoteAddress}:${socket.remotePort}`;
  let   buf     = '';  // accumulate partial data until \n

  console.log(`\n[+] New connection  ${connId}`);

  sessions.set(connId, { imei: null, vehicleRegNo: null, loggedIn: false });

  // ── Data handler ──
  socket.on('data', chunk => {
    // Log every raw chunk immediately — before line-splitting — so we can see
    // partial/binary/malformed data from devices that never send a full line.
    const hex = chunk.toString('hex').match(/.{1,2}/g).join(' ');
    const ascii = chunk.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
    console.log(`[${connId}] CHUNK (${chunk.length}B) ASCII: ${ascii}`);
    console.log(`[${connId}] CHUNK HEX: ${hex}`);

    buf += chunk.toString('ascii');

    // Process every complete line (\n-terminated; strip any \r)
    let newline;
    while ((newline = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, newline + 1);
      buf = buf.slice(newline + 1);
      handleLine(socket, connId, line.trim()).catch(err =>
        console.error(`[${connId}] Unhandled error:`, err.message)
      );
    }

    // Warn if buffer is growing without any newline (device not sending \\n)
    if (buf.length > 2048) {
      console.warn(`[${connId}] Buffer overflow (${buf.length}B, no newline) — flushing. Data: ${buf.slice(0, 200)}`);
      buf = '';
    }
  });

  socket.on('close',   ()    => { console.log(`[-] Connection closed  ${connId}`); sessions.delete(connId); });
  socket.on('error',   err   => console.error(`[${connId}] Socket error:`, err.message));
  socket.on('timeout', ()    => { console.warn(`[${connId}] Socket timeout — closing`); socket.destroy(); });

  socket.setTimeout(300_000); // 5-minute inactivity timeout
});

// ─── Per-line processor ───────────────────────────────────────────────────────
async function handleLine(socket, connId, rawLine) {
  if (!rawLine) return;

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`[${connId}] RAW: ${rawLine}`);

  const parsed = parseLine(rawLine);
  const { packetType, imei, data, checksumOk } = parsed;

  if (!checksumOk) {
    console.warn(`[${connId}] ⚠ Bad checksum — packet accepted but flagged`);
  }

  const session = sessions.get(connId) || {};

  // ── Update session from any packet that carries an IMEI ──────────────────
  if (imei && imei !== 'unknown') {
    session.imei         = imei;
    session.vehicleRegNo = data.vehicleRegNo || session.vehicleRegNo;
    sessions.set(connId, session);
  }

  const effectiveImei = imei || session.imei;

  // ── Logging ──────────────────────────────────────────────────────────────
  console.table([{
    'Packet Type':  packetType || '?',
    'IMEI':         effectiveImei || 'unknown',
    'Vehicle':      data.vehicleRegNo || session.vehicleRegNo || '—',
    'GPS Valid':    data.gpsValid ?? '—',
    'Lat':          data.latitude  != null ? data.latitude.toFixed(6)  : '—',
    'Lng':          data.longitude != null ? data.longitude.toFixed(6) : '—',
    'Speed km/h':   data.speed     ?? '—',
    'Ignition':     data.ignition  ?? '—',
    'Checksum OK':  checksumOk,
  }]);

  // ── Acknowledge all packets except inbound AKN ────────────────────────────
  if (packetType !== 'AKN') {
    const ack = buildAck(parsed);
    socket.write(ack);
    console.log(`[${connId}] → ACK: ${ack.trim()}`);
  }

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  if (packetType === 'AKN') {
    // Inbound ACKs from devices need no storage
    console.log(`[${connId}] Inbound AKN — skipped`);
    return;
  }

  if (!effectiveImei) {
    console.warn(`[${connId}] No IMEI — packet discarded`);
    return;
  }

  const doc = {
    imei:            effectiveImei,
    vehicleRegNo:    data.vehicleRegNo   || session.vehicleRegNo,
    vendorId:        data.vendorId,
    firmwareVersion: data.firmwareVersion,
    latitude:        data.gpsValid && data.latitude  != null ? data.latitude  : undefined,
    longitude:       data.gpsValid && data.longitude != null ? data.longitude : undefined,
    altitude:        data.altitude,
    speed:           data.speed,
    heading:         data.heading,
    satellites:      data.satellites,
    pdop:            data.pdop,
    hdop:            data.hdop,
    gpsValid:        data.gpsValid,
    latDir:          data.latDir,
    lngDir:          data.lngDir,
    mcc:             data.mcc,
    mnc:             data.mnc,
    lac:             data.lac,
    cellId:          data.cellId,
    gsmSignal:       data.gsmSignal,
    operatorName:    data.operatorName,
    ignition:        data.ignition,
    mainPowerStatus: data.mainPowerStatus,
    mainPowerVoltage:data.mainPowerVoltage,
    batteryVoltage:  data.batteryVoltage,
    emergencyStatus: data.emergencyStatus,
    tamperAlert:     data.tamperAlert,
    di1:             data.di1,
    di2:             data.di2,
    di3:             data.di3,
    di4:             data.di4,
    do1:             data.do1,
    do2:             data.do2,
    ai1:             data.ai1,
    ai2:             data.ai2,
    odometer:        data.odometer,
    alertType:       data.alertType,
    timestamp:       data.timestamp || new Date(),
    packetType,
    packetStatus:    data.packetStatus,
    replyNumber:     data.replyNumber,
    deviceType:      'AIS140',
    raw:             rawLine,
  };

  // Drop undefined fields
  Object.keys(doc).forEach(k => doc[k] === undefined && delete doc[k]);

  try {
    await Location.create(doc);
    console.log(`[${connId}] ✓ Saved ${packetType} for IMEI ${effectiveImei}`);
  } catch (err) {
    console.error(`[${connId}] ✗ MongoDB save error:`, err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  AIS140 / VLTD Device Server         ║`);
  console.log(`║  Listening on TCP port ${String(PORT).padEnd(13)}║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

server.on('error', err => {
  console.error('Server error:', err.message);
  process.exit(1);
});
