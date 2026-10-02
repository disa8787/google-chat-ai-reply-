'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyze } = require('../extension/detector');

const OFFERS = [
  // Screenshot from Google Chat (Uber Freight)
  `UF-6212077119 • Hammond, IN → Terrell, TX
Live pickup: Oct 02, 2026, 00:01 - 23:59 CDT
Live dropoff: Oct 05, 2026, 08:00 - 17:00 CDT
Dry van
Pallet (packaging type)
11387 lbs
$2460`,
  'Chicago, IL to Dallas, TX tomorrow 8am, 53 van 42k lbs, $1900 all in',
  'Have a load Atlanta GA - Miami FL, reefer, PU 10/3, DEL 10/4, 38,000#',
  'PU: Laredo, TX\nDEL: Joliet, IL\nFlatbed 45k\nRate 3200',
  'Salt Lake City, UT → Winston-Salem, NC 27101 van 40k $2500 pickup today',
  'CHICAGO,IL-DALLAS,TX 53 VAN 42K PU TMRW $1900',
  'Load #4471902 Memphis, TN -> Columbus, OH\nPickup 10/03 06:00 FCFS\nDelivery 10/04 appt\nReefer 34F, 40,000 lbs, 532 miles\nCan you cover?',
];

const NOT_OFFERS = [
  '$2460',
  'lmc -d',
  'Hi, do you have trucks available today?',
  'Hey Denis, how are you?',
  'Can you send me your MC number please',
  'Load # 2252449 Tracking Interrupted',
  'Driver checked in at pickup in Hammond, IN, ETA to Terrell, TX tomorrow 10:00',
  'Rate confirmation for load 3601307 attached, pickup Chicago, IL to Dallas, TX 10/2',
  'Did the driver pick up already? What is the ETA to delivery?',
  'Sounds great, thanks for confirming',
  'Please send the POD for invoice 3590028',
];

for (const text of OFFERS) {
  test(`offer: ${text.split('\n')[0].slice(0, 50)}`, () => {
    const r = analyze(text);
    assert.equal(r.isOffer, true, JSON.stringify(r));
    assert.ok(r.fingerprint);
  });
}

for (const text of NOT_OFFERS) {
  test(`not an offer: ${text.slice(0, 50)}`, () => {
    const r = analyze(text);
    assert.equal(r.isOffer, false, JSON.stringify(r));
  });
}

test('screenshot offer: route and load id are extracted', () => {
  const r = analyze(OFFERS[0]);
  assert.equal(r.route, 'Hammond, IN → Terrell, TX');
  assert.equal(r.loadId, 'UF-6212077119');
  assert.equal(r.fingerprint, 'id:UF-6212077119');
});

test('the same load sent twice has the same fingerprint', () => {
  const a = analyze(OFFERS[0]);
  const b = analyze(OFFERS[0].replace('$2460', '$2600'));
  assert.equal(a.fingerprint, b.fingerprint);
});

test('different loads have different fingerprints', () => {
  const a = analyze('Chicago, IL to Dallas, TX tomorrow, van 42k lbs $1900');
  const b = analyze('Chicago, IL to Houston, TX tomorrow, van 42k lbs $1900');
  assert.notEqual(a.fingerprint, b.fingerprint);
});
