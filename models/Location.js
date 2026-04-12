const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  // ── Device identification ────────────────────────────────────────────────────
  imei:           { type: String, required: true, index: true },
  vehicleRegNo:   String,  // Vehicle registration number from device
  vendorId:       String,  // AIS140 vendor identifier (e.g. "RP" for Roadpoint)
  firmwareVersion:String,

  // ── GPS positioning ──────────────────────────────────────────────────────────
  latitude:   Number,
  longitude:  Number,
  altitude:   Number,        // metres
  speed:      Number,        // km/h
  heading:    Number,        // 0-359 degrees
  satellites: Number,
  pdop:       Number,
  hdop:       Number,
  gpsValid:   Boolean,       // A = valid, V = invalid
  latDir:     String,        // N / S
  lngDir:     String,        // E / W

  // ── GSM / Cell-tower info ────────────────────────────────────────────────────
  mcc:        Number,
  mnc:        Number,
  lac:        Number,
  cellId:     Number,
  gsmSignal:  Number,        // 0-5
  operatorName: String,

  // ── Power & battery ──────────────────────────────────────────────────────────
  ignition:            Boolean,
  mainPowerStatus:     Boolean,  // 1 = main power present
  mainPowerVoltage:    Number,   // V
  batteryVoltage:      Number,   // V

  // ── I/O ──────────────────────────────────────────────────────────────────────
  di1: Boolean,
  di2: Boolean,
  di3: Boolean,
  di4: Boolean,
  do1: Boolean,
  do2: Boolean,
  ai1: Number,
  ai2: Number,
  odometer: Number,          // km

  // ── Alerts ───────────────────────────────────────────────────────────────────
  emergencyStatus: Boolean,  // panic / SOS
  tamperAlert:     Boolean,
  alertType:       String,   // populated for ALT/EMG packets

  // ── Packet metadata ──────────────────────────────────────────────────────────
  timestamp:    { type: Date, default: Date.now },
  packetType:   String,   // NMR, LGN, HBT, EMG, ALT, AKN …
  packetStatus: String,   // L = live, H = historical/buffered
  replyNumber:  Number,   // sequence counter from device
  deviceType:   { type: String, default: 'AIS140' },
  raw:          String,   // original raw ASCII line
}, { timestamps: true });

locationSchema.index({ imei: 1, timestamp: -1 });
locationSchema.index({ packetType: 1 });

module.exports = mongoose.model('Ais140Location', locationSchema, 'ais140locations');
