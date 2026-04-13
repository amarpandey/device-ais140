const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  // ── Device identification ────────────────────────────────────────────────────
  imei:            { type: String, required: true, index: true },
  vehicleRegNo:    String,   // Registration number from device (e.g. "RJ06GB7731")
  vendorId:        String,   // Vendor identifier (e.g. "ROADRPA")
  firmwareVersion: String,

  // ── GPS positioning ──────────────────────────────────────────────────────────
  latitude:   Number,
  longitude:  Number,
  altitude:   Number,    // metres
  speed:      Number,    // km/h
  heading:    Number,    // 0–359 degrees
  satellites: Number,
  pdop:       Number,
  hdop:       Number,
  gpsValid:   Boolean,   // true = valid fix
  latDir:     String,    // N / S
  lngDir:     String,    // E / W

  // ── GSM / Cell-tower info ────────────────────────────────────────────────────
  // mcc and mnc are always decimal (e.g. 404, 96) — stored as Number.
  // lac and cellId are HEX strings in ROADRPA format (e.g. "069A", "6C21").
  mcc:         String,
  mnc:         String,
  lac:         String,   // hex string (e.g. "01E6", "069A")
  cellId:      String,   // hex string (e.g. "6C21", "DDEB")
  gsmSignal:   Number,   // 0–31
  operatorName: String,

  // ── Power & battery ──────────────────────────────────────────────────────────
  // Stored as integer (0/1) to match server-side AIS140Location schema.
  // normalizeAIS140() converts to boolean via Boolean(doc.ignition).
  ignition:         Number,  // 1 = on, 0 = off
  mainPowerStatus:  Number,  // 1 = main power present
  mainPowerVoltage: Number,  // V
  batteryVoltage:   Number,  // V

  // ── I/O ──────────────────────────────────────────────────────────────────────
  di1: Number,
  di2: Number,
  di3: Number,
  di4: Number,
  do1: Number,
  do2: Number,
  ai1: Number,
  ai2: Number,
  odometer: Number,      // km

  // ── Alerts ───────────────────────────────────────────────────────────────────
  emergencyStatus: Number,  // 1 = emergency, 0 = normal
  tamperAlert:     Number,  // 1 = tamper detected
  alertType:       String,  // populated for ALT / EMG packets

  // ── Packet metadata ──────────────────────────────────────────────────────────
  timestamp:    { type: Date, default: Date.now, index: true },
  packetType:   String,   // NMR, LGN, HBT, EMG, ALT …
  packetStatus: String,   // L = live, H = historical / buffered
  replyNumber:  Number,   // sequence counter from device
  deviceType:   { type: String, default: 'AIS140' },
  raw:          String,   // original raw ASCII packet
}, {
  timestamps: true,
  strict: false,          // allow extra fields from newer firmware without schema changes
});

locationSchema.index({ imei: 1, timestamp: -1 });
locationSchema.index({ packetType: 1 });

module.exports = mongoose.model('Ais140Location', locationSchema, 'ais140locations');
