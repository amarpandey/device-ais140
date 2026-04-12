# AIS140 / VLTD Device Server

TCP server that receives, parses, and stores GPS packets from AIS140-compliant
VLTD (Vehicle Location Tracking Device) trackers — Roadpoint vendor format.

## Quick start

```bash
cd ais140
cp .env.example .env        # edit MONGODB_URI and PORT
npm install
npm start
```

## Test with the simulator

```bash
# In terminal 1
npm start

# In terminal 2 (optional args: host port imei vehicleRegNo)
node simulator.js 127.0.0.1 5010 123456789012345 MH12AB1234
```

The simulator:
1. Sends a LGN (login) packet
2. Sends NMR (normal reporting) packets every 5 s, drifting position around Mumbai
3. Sends one EMG (emergency/SOS) packet at tick 6
4. Sends one HBT (heartbeat) packet at tick 10
5. Closes after 15 ticks

## Packet types

| Code | Name              | Description                              |
|------|-------------------|------------------------------------------|
| LGN  | Login             | First packet; registers the device IMEI |
| NMR  | Normal reporting  | Periodic live location update            |
| HBT  | Heartbeat         | Keep-alive (GPS fields may be empty)     |
| EMG  | Emergency         | Panic/SOS alert with GPS                 |
| ALT  | Alert             | Speed / geofence / tamper alert          |
| AKN  | Acknowledgment    | Server → device response (and vice-versa)|

## Packet field layout

All non-heartbeat packets share the same 42-field pipe-delimited body.
See `parser.js` for full field documentation.

```
RP|V1.0|NMR|<IMEI>|<VehicleRegNo>|<SeqNo>|L|<DDMMYYYY>|<HHMMSS>|A|
<Lat>|N|<Lng>|E|<Speed>|<Heading>|<Sats>|<Alt>|<PDOP>|<HDOP>|
<Operator>|<Ign>|<MainPower>|<MainV>|<BattV>|<EMG>|<Tamper>|
<GSM>|<MCC>|<MNC>|<LAC>|<CellID>|<NMEA>|<DI1>|<DI2>|<DI3>|<DI4>|
<DO1>|<DO2>|<AI1>|<AI2>|<Odometer>*<XOR_Checksum>\r\n
```

## Environment variables

| Variable     | Default                              | Description               |
|--------------|--------------------------------------|---------------------------|
| PORT         | 5010                                 | TCP port to listen on     |
| MONGODB_URI  | mongodb://localhost:27017/di-stage   | MongoDB connection string |

## MongoDB collection

Packets are stored in the **`ais140locations`** collection.
The main DriveInnovate server reads this collection via its change-stream
pipeline (add `AIS140` as a device type in the Master Settings, with
`mongoCollection: ais140locations`).
