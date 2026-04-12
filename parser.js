'use strict';

/**
 * AIS140 / VLTD packet parser — Roadpoint vendor format
 *
 * All packets are ASCII text lines terminated with \r\n.
 * Fields are pipe-separated ( | ).
 * A checksum byte follows the last field, delimited by *.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  General frame                                                            │
 * │  <FIELD0>|<FIELD1>|…|<FIELDn>*<XOR_CHECKSUM>\r\n                        │
 * │                                                                           │
 * │  Checksum = XOR of all ASCII bytes between the first char and '*'        │
 * │  (the '*' itself and the \r\n are excluded from XOR)                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Packet types
 * ─────────────
 *  LGN  Login — first packet from a new device connection
 *  NMR  Normal reporting (periodic location update)
 *  HBT  Heartbeat (keep-alive, no GPS payload)
 *  EMG  Emergency / panic alert
 *  ALT  Alert / alarm
 *  AKN  Acknowledgment (server→device, also used device→server)
 *
 * Field layout (all non-login types share the same 42-field body):
 *
 *  [0]  Vendor ID               e.g. "RP"
 *  [1]  Firmware version        e.g. "V1.0"
 *  [2]  Packet type             NMR / HBT / EMG / ALT / LGN
 *  [3]  IMEI (15 digits)
 *  [4]  Vehicle registration number
 *  [5]  Reply / sequence number
 *  [6]  Packet status           L = live, H = historical
 *  [7]  Date                    DDMMYYYY
 *  [8]  Time                    HHMMSS
 *  [9]  GPS validity            A = valid, V = invalid
 *  [10] Latitude                DD.MMMMM decimal degrees
 *  [11] Latitude direction      N / S
 *  [12] Longitude               DDD.MMMMM decimal degrees
 *  [13] Longitude direction     E / W
 *  [14] Speed                   km/h (float)
 *  [15] Heading / course        0-359 degrees
 *  [16] Number of satellites
 *  [17] Altitude                metres
 *  [18] PDOP
 *  [19] HDOP
 *  [20] Operator name           e.g. "Airtel"
 *  [21] Ignition status         1 / 0
 *  [22] Main power status       1 / 0
 *  [23] Main power voltage      V (float, e.g. 12.34)
 *  [24] Internal battery voltage V (float)
 *  [25] Emergency status        1 / 0
 *  [26] Tamper alert            1 / 0
 *  [27] GSM signal strength     0-5
 *  [28] MCC
 *  [29] MNC
 *  [30] LAC
 *  [31] Cell ID
 *  [32] NMEA sentence           (optional, may be empty)
 *  [33] Digital input 1         1 / 0
 *  [34] Digital input 2         1 / 0
 *  [35] Digital input 3         1 / 0
 *  [36] Digital input 4         1 / 0
 *  [37] Digital output 1        1 / 0
 *  [38] Digital output 2        1 / 0
 *  [39] Analog input 1          raw ADC value
 *  [40] Analog input 2          raw ADC value
 *  [41] Odometer                km (float)
 *
 * For HBT only fields [0]-[8] are guaranteed; GPS fields will be empty.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** XOR checksum over the entire string up to (not including) '*' */
function computeChecksum(line) {
  const end = line.indexOf('*');
  const payload = end === -1 ? line : line.slice(0, end);
  let xor = 0;
  for (let i = 0; i < payload.length; i++) xor ^= payload.charCodeAt(i);
  return xor;
}

/** Verify the *XX suffix matches the XOR of the rest of the line */
function verifyChecksum(line) {
  const star = line.indexOf('*');
  if (star === -1) return true; // no checksum present → accept
  const expected = parseInt(line.slice(star + 1).replace(/[\r\n]/g, ''), 16);
  const actual   = computeChecksum(line);
  return actual === expected;
}

/** Parse DDMMYYYY + HHMMSS → UTC Date */
function parseDateTime(dateDDMMYYYY, timeHHMMSS) {
  if (!dateDDMMYYYY || !timeHHMMSS) return new Date();
  const d  = dateDDMMYYYY.padStart(8, '0');
  const t  = timeHHMMSS.padStart(6, '0');
  const dd = parseInt(d.slice(0, 2), 10);
  const mm = parseInt(d.slice(2, 4), 10) - 1;
  const yy = parseInt(d.slice(4, 8), 10);
  const hh = parseInt(t.slice(0, 2), 10);
  const mi = parseInt(t.slice(2, 4), 10);
  const ss = parseInt(t.slice(4, 6), 10);
  const dt = new Date(Date.UTC(yy, mm, dd, hh, mi, ss));
  return isNaN(dt.getTime()) ? new Date() : dt;
}

/** Parse a latitude/longitude string → decimal degrees (handles both decimal and DDMM.MMMMM) */
function parseCoord(raw, dir) {
  if (!raw || raw === '' || raw === '0.0' || raw === '0') return null;
  let val = parseFloat(raw);
  if (isNaN(val)) return null;

  // Detect DDMM.MMMMM vs pure decimal by magnitude
  // Latitudes in NMEA form are > 100 only if encoded as DDDMM.MMMMM (longitudes start at 1000+)
  // Roadpoint spec uses pure decimal but some firmwares send NMEA-style
  if (val > 360) {
    // NMEA style: DDMM.MMMMM for lat, DDDMM.MMMMM for lon
    const degrees = Math.floor(val / 100);
    const minutes = val - degrees * 100;
    val = degrees + minutes / 60;
  }

  if (dir === 'S' || dir === 'W') val = -val;
  return val;
}

const NUM  = (v) => { const n = parseFloat(v); return isNaN(n) ? undefined : n; };
const INT  = (v) => { const n = parseInt(v, 10); return isNaN(n) ? undefined : n; };
const BOOL = (v) => v === '1' || v === 'true' || v === 'TRUE';

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a single raw AIS140 text line.
 *
 * @param {string} line  — raw ASCII line (may still contain \r\n)
 * @returns {{ packetType, imei, data, checksumOk, raw }}
 */
function parseLine(line) {
  const raw = line.replace(/[\r\n]+$/, '');

  // Strip checksum suffix before splitting fields
  const starPos  = raw.indexOf('*');
  const payload  = starPos === -1 ? raw : raw.slice(0, starPos);
  const checksumOk = verifyChecksum(raw);

  const f = payload.split('|');

  // Identify packet type — field[2] is canonical, but some implementations put it in field[0]
  // Normalise by checking both positions.
  let packetType = (f[2] || f[0] || '').trim().toUpperCase();
  if (!['LGN', 'NMR', 'HBT', 'EMG', 'ALT', 'AKN'].includes(packetType)) {
    // Try field[0] as packet type (some firmwares omit the first two header fields)
    const f0 = (f[0] || '').trim().toUpperCase();
    if (['LGN', 'NMR', 'HBT', 'EMG', 'ALT', 'AKN'].includes(f0)) {
      packetType = f0;
    }
  }

  const data = {
    vendorId:        f[0]  || undefined,
    firmwareVersion: f[1]  || undefined,
    packetType,
    imei:            (f[3]  || '').trim() || undefined,
    vehicleRegNo:    f[4]  || undefined,
    replyNumber:     INT(f[5]),
    packetStatus:    f[6]  || undefined,   // L or H
    timestamp:       parseDateTime(f[7], f[8]),
    gpsValid:        f[9]  === 'A',
    latitude:        parseCoord(f[10], f[11]),
    latDir:          f[11] || undefined,
    longitude:       parseCoord(f[12], f[13]),
    lngDir:          f[13] || undefined,
    speed:           NUM(f[14]),
    heading:         NUM(f[15]),
    satellites:      INT(f[16]),
    altitude:        NUM(f[17]),
    pdop:            NUM(f[18]),
    hdop:            NUM(f[19]),
    operatorName:    f[20] || undefined,
    ignition:        f[21] !== undefined ? BOOL(f[21]) : undefined,
    mainPowerStatus: f[22] !== undefined ? BOOL(f[22]) : undefined,
    mainPowerVoltage:NUM(f[23]),
    batteryVoltage:  NUM(f[24]),
    emergencyStatus: f[25] !== undefined ? BOOL(f[25]) : undefined,
    tamperAlert:     f[26] !== undefined ? BOOL(f[26]) : undefined,
    gsmSignal:       INT(f[27]),
    mcc:             INT(f[28]),
    mnc:             INT(f[29]),
    lac:             INT(f[30]),
    cellId:          INT(f[31]),
    // f[32] = NMEA sentence (skip, redundant)
    di1:             f[33] !== undefined ? BOOL(f[33]) : undefined,
    di2:             f[34] !== undefined ? BOOL(f[34]) : undefined,
    di3:             f[35] !== undefined ? BOOL(f[35]) : undefined,
    di4:             f[36] !== undefined ? BOOL(f[36]) : undefined,
    do1:             f[37] !== undefined ? BOOL(f[37]) : undefined,
    do2:             f[38] !== undefined ? BOOL(f[38]) : undefined,
    ai1:             NUM(f[39]),
    ai2:             NUM(f[40]),
    odometer:        NUM(f[41]),
  };

  // For EMG / ALT packets the alert type can appear as an extra field after odometer
  if ((packetType === 'EMG' || packetType === 'ALT') && f[42]) {
    data.alertType = f[42].trim();
  }

  // Remove undefined keys to keep the object clean
  Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);

  return {
    packetType,
    imei:        data.imei || null,
    data,
    checksumOk,
    raw,
  };
}

// ─── ACK builder ─────────────────────────────────────────────────────────────

/**
 * Build the server → device acknowledgment string.
 *
 * Format:
 *   AKN|<vendorId>|<fwVersion>|<packetType>|<imei>|<vehicleRegNo>|<replyNum>|
 *   <status>|<DDMMYYYY>|<HHMMSS>*<XOR>\r\n
 *
 * status: 1 = accepted, 0 = rejected (checksum bad)
 */
function buildAck(parsed) {
  const now = new Date();
  const dd  = String(now.getUTCDate()).padStart(2, '0');
  const mm  = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yy  = now.getUTCFullYear();
  const hh  = String(now.getUTCHours()).padStart(2, '0');
  const mi  = String(now.getUTCMinutes()).padStart(2, '0');
  const ss  = String(now.getUTCSeconds()).padStart(2, '0');

  const d    = parsed.data;
  const vid  = d.vendorId        || 'RP';
  const fw   = d.firmwareVersion || 'V1.0';
  const imei = d.imei            || '';
  const reg  = d.vehicleRegNo    || '';
  const rep  = d.replyNumber != null ? String(d.replyNumber) : '1';
  const ok   = parsed.checksumOk ? '1' : '0';

  const body = `AKN|${vid}|${fw}|${parsed.packetType}|${imei}|${reg}|${rep}|${ok}|${dd}${mm}${yy}|${hh}${mi}${ss}`;
  const cs   = computeChecksum(body);
  return `${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
}

module.exports = { parseLine, buildAck, verifyChecksum, computeChecksum };
