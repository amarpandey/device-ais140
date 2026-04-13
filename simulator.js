'use strict';
/**
 * AIS140 Device Simulator
 *
 * Connects to the AIS140 server, sends a LGN (login) packet, then sends NMR
 * (normal reporting) packets every 5 seconds, slowly moving the position.
 *
 * Usage:
 *   node simulator.js [HOST] [PORT]
 *   node simulator.js localhost 5010
 */

const net = require('net');

const HOST  = process.argv[2] || '127.0.0.1';
const PORT  = parseInt(process.argv[3] || '5025', 10);
const IMEI  = process.argv[4] || '123456789012345';
const REGNO = process.argv[5] || 'MH12AB1234';

// XOR checksum over the full payload string
function checksum(str) {
  let xor = 0;
  for (let i = 0; i < str.length; i++) xor ^= str.charCodeAt(i);
  return xor.toString(16).toUpperCase().padStart(2, '0');
}

function nowDate() {
  const d = new Date();
  return String(d.getUTCDate()).padStart(2,'0')
       + String(d.getUTCMonth()+1).padStart(2,'0')
       + d.getUTCFullYear();
}
function nowTime() {
  const d = new Date();
  return String(d.getUTCHours()).padStart(2,'0')
       + String(d.getUTCMinutes()).padStart(2,'0')
       + String(d.getUTCSeconds()).padStart(2,'0');
}

let seq = 1;

function buildPacket(type, lat, lng, speed, ignition) {
  // Field layout — matches parser.js documentation
  const f = [
    'RP',           // [0]  Vendor ID
    'V1.0',         // [1]  Firmware version
    type,           // [2]  Packet type
    IMEI,           // [3]  IMEI
    REGNO,          // [4]  Vehicle reg no
    seq++,          // [5]  Reply / sequence number
    'L',            // [6]  Packet status: L = live
    nowDate(),      // [7]  Date DDMMYYYY
    nowTime(),      // [8]  Time HHMMSS
    'A',            // [9]  GPS validity: A = valid
    lat.toFixed(6), // [10] Latitude
    'N',            // [11] Lat direction
    lng.toFixed(6), // [12] Longitude
    'E',            // [13] Lng direction
    speed.toFixed(1),// [14] Speed km/h
    '45',           // [15] Heading
    '9',            // [16] Satellites
    '220',          // [17] Altitude m
    '1.2',          // [18] PDOP
    '0.9',          // [19] HDOP
    'Airtel',       // [20] Operator
    ignition?'1':'0',// [21] Ignition
    '1',            // [22] Main power status
    '12.40',        // [23] Main power voltage
    '3.85',         // [24] Battery voltage
    '0',            // [25] Emergency
    '0',            // [26] Tamper
    '4',            // [27] GSM signal
    '404',          // [28] MCC (India)
    '20',           // [29] MNC (Airtel)
    '1234',         // [30] LAC
    '56789',        // [31] Cell ID
    '',             // [32] NMEA sentence
    '0',            // [33] DI1
    '0',            // [34] DI2
    '0',            // [35] DI3
    '0',            // [36] DI4
    '0',            // [37] DO1
    '0',            // [38] DO2
    '0',            // [39] AI1
    '0',            // [40] AI2
    (1000 + seq * 0.1).toFixed(1), // [41] Odometer km
  ].join('|');

  return `${f}*${checksum(f)}\r\n`;
}

// ─── Simulate an emergency packet ─────────────────────────────────────────────
function buildEmergency(lat, lng) {
  const f = [
    'RP', 'V1.0', 'EMG', IMEI, REGNO, seq++, 'L',
    nowDate(), nowTime(), 'A',
    lat.toFixed(6), 'N', lng.toFixed(6), 'E',
    '0.0', '0', '9', '220', '1.2', '0.9', 'Airtel',
    '0', '1', '12.40', '3.85',
    '1',  // emergencyStatus = 1
    '0', '4', '404', '20', '1234', '56789',
    '', '0', '0', '0', '0', '0', '0', '0', '0', '1000.0',
    'SOS', // alertType
  ].join('|');
  return `${f}*${checksum(f)}\r\n`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const client = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log(`[Simulator] Connected to AIS140 server at ${HOST}:${PORT}`);
  console.log(`[Simulator] IMEI: ${IMEI}  VehicleRegNo: ${REGNO}`);

  // 1. Send login packet
  const lgn = buildPacket('LGN', 19.0760, 72.8777, 0, false);
  console.log(`\n→ LGN: ${lgn.trim()}`);
  client.write(lgn);

  let lat   = 19.0760;
  let lng   = 72.8777;
  let speed = 0;
  let ign   = true;
  let tick  = 0;

  // 2. Send NMR every 5 seconds
  const interval = setInterval(() => {
    tick++;
    lat   += 0.0003 + Math.random() * 0.0002;
    lng   += 0.0002 + Math.random() * 0.0002;
    speed  = 20 + Math.round(Math.random() * 40);

    if (tick === 6) {
      // Send one emergency packet mid-route
      const emg = buildEmergency(lat, lng);
      console.log(`\n→ EMG: ${emg.trim()}`);
      client.write(emg);
      return;
    }

    if (tick === 10) {
      // Send a heartbeat
      const hbt = buildPacket('HBT', lat, lng, 0, true);
      console.log(`\n→ HBT: ${hbt.trim()}`);
      client.write(hbt);
      return;
    }

    const nmr = buildPacket('NMR', lat, lng, speed, ign);
    console.log(`\n→ NMR #${tick}: ${nmr.trim()}`);
    client.write(nmr);

    if (tick >= 15) {
      console.log('[Simulator] Done — closing');
      clearInterval(interval);
      client.end();
    }
  }, 5000);
});

client.on('data', data => {
  console.log(`← ACK: ${data.toString().trim()}`);
});

client.on('close', () => console.log('[Simulator] Connection closed'));
client.on('error', err => console.error('[Simulator] Error:', err.message));
