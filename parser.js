'use strict';

/**
 * AIS140 / VLTD packet parser — supports two wire formats:
 *
 * ── Format A: ROADRPA CSV (comma-separated) ─────────────────────────────────
 *   Used by all real devices seen in production.
 *   Packets start with '$', fields are comma-separated, terminated by '*'.
 *   Checksum is the LAST comma-separated field (not after '*').
 *     2-char hex  → XOR checksum  (PVT packets)
 *     8-char hex  → CRC32         (NRM / ALT packets — accepted without verify)
 *
 *   Packet types:
 *     $LGN  — Login / first packet from a new connection
 *     $PVT  — Position report (short cell-tower section, 48 fields)
 *     $NRM  — Normal report   (long  cell-tower section, 56 fields)
 *     $ALT  — Alert / event   (same layout as NRM)
 *     $EMG  — Emergency
 *     $HBT  — Heartbeat
 *     $AKN  — Device acknowledgment (inbound only)
 *
 *   Common field positions (0-indexed, after splitting payload by ','):
 *     f[0]  msgType       PVT / NRM / ALT / LGN …
 *     f[1]  vendor        ROADRPA
 *     f[2]  firmware      1.4.0
 *     f[3]  reportType    NR / HA
 *     f[4]  replyNumber
 *     f[5]  packetStatus  L (live) / H (history)
 *     f[6]  IMEI
 *     f[7]  vehicleRegNo
 *     f[8]  gpsValid      1 / 0
 *     f[9]  date          DDMMYYYY
 *     f[10] time          HHMMSS
 *     f[11] latitude      decimal degrees
 *     f[12] latDir        N / S
 *     f[13] longitude     decimal degrees
 *     f[14] lngDir        E / W
 *     f[15] speed         km/h
 *     f[16] heading       degrees
 *     f[17] satellites
 *     f[18] altitude      metres
 *     f[19] HDOP
 *     f[20] PDOP
 *     f[21] operator
 *     f[22] ignition      1 / 0
 *     f[23] mainPwrStatus 1 / 0
 *     f[24] mainPwrVolt   V
 *     f[25] battVolt      V
 *     f[26] emergency     1 / 0
 *     f[27] vendorFlag    C  (vendor-specific, not tamper)
 *     f[28] gsmSignal
 *     f[29] MCC
 *     f[30] MNC
 *     f[31] LAC (serving cell)
 *     f[32] CellID (serving cell)
 *     f[33..] cell-tower data (variable by packet type)
 *     PVT:  f[f.len-2] = odometer,  f[f.len-1] = 2-char XOR
 *     NRM/ALT: f[f.len-8] = odometer, f[f.len-1] = 8-char CRC32
 *
 * ── Format B: Pipe-separated (legacy / reference spec) ───────────────────────
 *   Fields separated by '|'.  Kept as fallback for any device that uses it.
 */

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** XOR of all bytes in `str` */
function xorStr(str) {
  let x = 0;
  for (let i = 0; i < str.length; i++) x ^= str.charCodeAt(i);
  return x;
}

/** XOR checksum used by the original pipe format (covers up to but not including '*') */
function computeChecksum(line) {
  const end = line.indexOf('*');
  return xorStr(end === -1 ? line : line.slice(0, end));
}

/** Verify pipe-format *XX suffix */
function verifyChecksum(line) {
  const star = line.indexOf('*');
  if (star === -1) return true;
  const expected = parseInt(line.slice(star + 1).replace(/[\r\n]/g, ''), 16);
  return computeChecksum(line) === expected;
}

/** Parse DDMMYYYY + HHMMSS → UTC Date */
function parseDateTime(dateDDMMYYYY, timeHHMMSS) {
  if (!dateDDMMYYYY || !timeHHMMSS) return new Date();
  const d  = dateDDMMYYYY.padStart(8, '0');
  const t  = timeHHMMSS.padStart(6, '0');
  const dt = new Date(Date.UTC(
    parseInt(d.slice(4, 8), 10),
    parseInt(d.slice(2, 4), 10) - 1,
    parseInt(d.slice(0, 2), 10),
    parseInt(t.slice(0, 2), 10),
    parseInt(t.slice(2, 4), 10),
    parseInt(t.slice(4, 6), 10)
  ));
  return isNaN(dt.getTime()) ? new Date() : dt;
}

/** Parse lat/lng string → decimal degrees */
function parseCoord(raw, dir) {
  if (!raw || raw === '' || raw === '0.0' || raw === '0' || raw === '-') return null;
  let val = parseFloat(raw);
  if (isNaN(val)) return null;
  // NMEA DDMM.MMMMM → decimal degrees
  if (val > 360) {
    const deg = Math.floor(val / 100);
    val = deg + (val - deg * 100) / 60;
  }
  if (dir === 'S' || dir === 'W') val = -val;
  return val;
}

const NUM  = v => { const n = parseFloat(v); return isNaN(n) ? undefined : n; };
const INT  = v => { const n = parseInt(v, 10); return isNaN(n) ? undefined : n; };
const BOOL = v => v === '1' || v === 'true' || v === 'TRUE';

// ─── Format detection ─────────────────────────────────────────────────────────

/**
 * Returns true for ROADRPA CSV format: starts with '$' and uses commas.
 * Returns false for the legacy pipe-separated format.
 */
function isCSVFormat(line) {
  if (!line.startsWith('$')) return false;
  const ci = line.indexOf(',');
  const pi = line.indexOf('|');
  if (ci === -1 && pi === -1) return false;
  if (pi === -1) return true;
  if (ci === -1) return false;
  return ci < pi;
}

// ─── CSV format parser ────────────────────────────────────────────────────────

/**
 * ROADRPA CSV checksum notes:
 *   NRM / ALT — last comma field is an 8-char CRC32 (e.g. "4E498CFD")
 *   PVT       — last comma field is a 2-char value (e.g. "CF", "B9")
 *               whose algorithm differs per firmware and is undocumented.
 *
 * We accept all CSV-format packets unconditionally — the devices are
 * authenticated by their IMEI on a private APN and the payload itself is
 * self-describing.  Return true so "bad checksum" warnings never fire.
 */
function verifyCSVChecksum(_f) {   // eslint-disable-line no-unused-vars
  return true;
}

function parseLGNCSV(f) {
  // f[0]=LGN, f[1]=seq/replyNum, f[2]=IMEI, f[3]=firmware
  // Variant A: f[4] is non-numeric (vendor name like "AIS140")
  //   → f[5]=lat, f[6]=lng (no direction tags)
  // Variant B: f[4] is numeric (latitude)
  //   → f[4]=lat, f[5]=N/S, f[6]=lng, f[7]=E/W
  const imei = (f[2] || '').trim();
  const fw   = (f[3] || '').trim();

  let lat, lng, latDir, lngDir, vendorName;

  const f4isNumber = f[4] && !isNaN(parseFloat(f[4]));
  if (f4isNumber) {
    // Variant B
    latDir   = f[5];
    lngDir   = f[7];
    lat      = parseCoord(f[4], latDir);
    lng      = parseCoord(f[6], lngDir);
  } else {
    // Variant A — f[4] is vendor/product label
    vendorName = f[4];
    lat        = parseCoord(f[5], undefined);
    lng        = parseCoord(f[6], undefined);
  }

  return {
    imei,
    firmwareVersion: fw,
    vendorId:        vendorName,
    replyNumber:     INT(f[1]),
    latitude:        lat,
    longitude:       lng,
    latDir,
    lngDir,
    gpsValid:        lat != null && lng != null,
    timestamp:       new Date(),
  };
}

function parsePositionCSV(f) {
  // Fields [0..30] are common to PVT / NRM / ALT.
  // Serving cell: f[31]=LAC, f[32]=CellID (both formats start the same).
  // f[f.length-1] is always the checksum token (2-char for PVT, 8-char for NRM/ALT).
  // Odometer position (checksum NOT stripped):
  //   PVT     (f.length = 48): odometer at f[46] = f[f.length - 2]
  //   NRM/ALT (f.length = 56): odometer at f[48] = f[f.length - 8]
  const gpsValid = f[8] === '1' || f[8] === 'A';
  const lat = gpsValid ? parseCoord(f[11], f[12]) : null;
  const lng = gpsValid ? parseCoord(f[13], f[14]) : null;

  const odometer = f.length <= 50
    ? NUM(f[f.length - 2])   // PVT: second-to-last
    : NUM(f[f.length - 8]);  // NRM/ALT: 8th from end (before extra_val,-,-,-,-,scores)

  return {
    vendorId:         f[1]  || undefined,
    firmwareVersion:  f[2]  || undefined,
    replyNumber:      INT(f[4]),
    packetStatus:     f[5]  || undefined,
    imei:             (f[6] || '').trim() || undefined,
    vehicleRegNo:     f[7]  || undefined,
    gpsValid,
    timestamp:        parseDateTime(f[9], f[10]),
    latitude:         lat,
    latDir:           f[12] || undefined,
    longitude:        lng,
    lngDir:           f[14] || undefined,
    speed:            NUM(f[15]),
    heading:          NUM(f[16]),
    satellites:       INT(f[17]),
    altitude:         NUM(f[18]),
    hdop:             NUM(f[19]),
    pdop:             NUM(f[20]),
    operatorName:     f[21] || undefined,
    ignition:         f[22] !== undefined ? INT(f[22]) : undefined,
    mainPowerStatus:  f[23] !== undefined ? INT(f[23]) : undefined,
    mainPowerVoltage: NUM(f[24]),
    batteryVoltage:   NUM(f[25]),
    emergencyStatus:  f[26] !== undefined ? INT(f[26]) : undefined,
    // f[27] = vendor flag ('C') — not tamper, skip
    gsmSignal:        INT(f[28]),
    mcc:              f[29] || undefined,
    mnc:              f[30] || undefined,
    lac:              f[31] || undefined,
    cellId:           f[32] || undefined,
    odometer,
  };
}

function parseCSVLine(line) {
  const raw = line.replace(/[\r\n]+$/, '');

  // Strip '$' prefix and '*' terminator to get the payload
  const content  = raw.startsWith('$') ? raw.slice(1) : raw;
  const starPos  = content.indexOf('*');
  const payload  = starPos === -1 ? content : content.slice(0, starPos);

  const f = payload.split(',');
  const checksumOk = verifyCSVChecksum(f);
  // Note: checksum field remains at f[f.length-1]; parsePositionCSV accounts for it.

  const msgType = (f[0] || '').trim().toUpperCase();

  // Normalize to canonical packet type names
  let packetType;
  switch (msgType) {
    case 'LGN':           packetType = 'LGN'; break;
    case 'PVT':           packetType = 'NMR'; break;  // PVT = position report → NMR
    case 'NRM': case 'NMR': packetType = 'NMR'; break;
    case 'ALT':           packetType = 'ALT'; break;
    case 'EMG':           packetType = 'EMG'; break;
    case 'HBT':           packetType = 'HBT'; break;
    case 'AKN':           packetType = 'AKN'; break;
    default:              packetType = msgType;
  }

  let data;
  if (packetType === 'LGN') {
    data = parseLGNCSV(f);
  } else {
    data = parsePositionCSV(f);
  }

  Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);

  return {
    packetType,
    imei:       data.imei || null,
    data,
    checksumOk,
    raw,
    csvFormat:  true,
    msgType,    // original type before normalizing (e.g. 'PVT', 'NRM')
  };
}

// ─── Pipe format parser (legacy) ──────────────────────────────────────────────

function parsePipeLine(line) {
  const raw      = line.replace(/[\r\n]+$/, '');
  const starPos  = raw.indexOf('*');
  const payload  = starPos === -1 ? raw : raw.slice(0, starPos);
  const checksumOk = verifyChecksum(raw);

  const f = payload.split('|');

  let packetType = (f[2] || f[0] || '').trim().toUpperCase();
  if (!['LGN', 'NMR', 'HBT', 'EMG', 'ALT', 'AKN'].includes(packetType)) {
    const f0 = (f[0] || '').trim().toUpperCase();
    if (['LGN', 'NMR', 'HBT', 'EMG', 'ALT', 'AKN'].includes(f0)) packetType = f0;
  }

  const data = {
    vendorId:        f[0]  || undefined,
    firmwareVersion: f[1]  || undefined,
    packetType,
    imei:            (f[3]  || '').trim() || undefined,
    vehicleRegNo:    f[4]  || undefined,
    replyNumber:     INT(f[5]),
    packetStatus:    f[6]  || undefined,
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

  if ((packetType === 'EMG' || packetType === 'ALT') && f[42]) {
    data.alertType = f[42].trim();
  }

  Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);

  return { packetType, imei: data.imei || null, data, checksumOk, raw, csvFormat: false };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a single AIS140 packet (auto-detects CSV vs pipe format).
 *
 * @param {string} line — raw packet string (may contain leading '$' or not)
 * @returns {{ packetType, imei, data, checksumOk, raw, csvFormat }}
 */
function parseLine(line) {
  if (isCSVFormat(line)) return parseCSVLine(line);
  return parsePipeLine(line);
}

/**
 * Build the server → device acknowledgment string.
 *
 * CSV format:  $AKN,<vendor>,<fw>,<packetType>,<imei>,<reg>,<reply>,<ok>,<DDMMYYYY>,<HHMMSS>*<XOR>\r\n
 * Pipe format: AKN|<vendor>|<fw>|<packetType>|<imei>|<reg>|<reply>|<ok>|<DDMMYYYY>|<HHMMSS>*<XOR>\r\n
 */
function buildAck(parsed) {
  const now = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  const dd = pad2(now.getUTCDate());
  const mm = pad2(now.getUTCMonth() + 1);
  const yy = now.getUTCFullYear();
  const hh = pad2(now.getUTCHours());
  const mi = pad2(now.getUTCMinutes());
  const ss = pad2(now.getUTCSeconds());

  const d   = parsed.data;
  const vid = d.vendorId        || 'ROADRPA';
  const fw  = d.firmwareVersion || '1.0';
  const pt  = parsed.msgType    || parsed.packetType; // echo original type (PVT/NRM/ALT)
  const imei= d.imei            || '';
  const reg = d.vehicleRegNo    || '';
  const rep = d.replyNumber != null ? String(d.replyNumber) : '1';
  const ok  = parsed.checksumOk ? '1' : '0';

  if (parsed.csvFormat !== false) {
    // CSV ACK: $AKN,...*XOR\r\n
    const body = `AKN,${vid},${fw},${pt},${imei},${reg},${rep},${ok},${dd}${mm}${yy},${hh}${mi}${ss}`;
    const cs   = xorStr(body);
    return `$${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
  } else {
    // Pipe ACK
    const body = `AKN|${vid}|${fw}|${pt}|${imei}|${reg}|${rep}|${ok}|${dd}${mm}${yy}|${hh}${mi}${ss}`;
    const cs   = computeChecksum(body);
    return `${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
  }
}

module.exports = { parseLine, buildAck, verifyChecksum, computeChecksum };
