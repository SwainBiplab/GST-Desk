/**
 * e-Way Bill: the payload (Part A and Part B), and the rules of rule 138 that decide whether one is
 * needed, how long it is valid, and when it can be extended or cancelled. Rules are data
 * (`data/ewb-rules.ts`).
 */
import { EWB_RULES_V1, type EwbRules } from '../../data/ewb-rules';
import { checkGstin } from '../gstin';
import { divRound, toDecimalString } from '../money';

import { portalDate } from './payload';
import type { EinvProblem } from './types';

type Json = Record<string, unknown>;
const r2 = (p: number): number => Number(toDecimalString(BigInt(p), 2));
const r3qty = (micros: number): number =>
  Number(toDecimalString(divRound(BigInt(micros), 1000n), 3));
const pct = (bp: number): number => Number(toDecimalString(BigInt(bp), 2));

export interface EwbAddress {
  /** `URP` for an unregistered person. */
  gstin: string;
  name: string;
  addr1: string;
  addr2?: string;
  place: string;
  pincode: string;
  stateCode: string;
}

export interface EwbLine {
  name: string;
  hsn: string;
  qtyMicros: number;
  uqc: string;
  taxablePaise: number;
  cgstRateBp: number;
  sgstRateBp: number;
  igstRateBp: number;
  cessRateBp: number;
}

export interface EwbTransport {
  mode: 'road' | 'rail' | 'air' | 'ship';
  /** 0 lets the portal work the distance out from the two pincodes. */
  distanceKm: number;
  transporterId?: string;
  transporterName?: string;
  vehicleNo?: string;
  vehicleType: 'regular' | 'odc';
  transDocNo?: string;
  transDocDate?: string;
}

export interface EwbInput {
  /** Our document type (mapped to the portal's). */
  docType: string;
  number: string;
  date: string;
  /** O outward, I inward. */
  supplyType: 'O' | 'I';
  /** 1 supply, 2 import, 3 export, 4 job work, 5 own use, 7 sales return, 8 others… */
  subSupplyType: string;
  from: EwbAddress;
  to: EwbAddress;
  /** 1 regular, 2 bill to - ship to, 3 bill from - dispatch from, 4 both. */
  transactionType: 1 | 2 | 3 | 4;
  values: {
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    otherPaise: number;
    totalPaise: number;
  };
  lines: EwbLine[];
  transport: EwbTransport;
}

/** The e-way bill JSON, Part A and (when the vehicle or transport document is known) Part B. */
export function buildEwb(e: EwbInput, rules: EwbRules = EWB_RULES_V1): Json {
  const out: Json = {
    supplyType: e.supplyType,
    subSupplyType: e.subSupplyType,
    docType: rules.docTypes[e.docType] ?? 'OTH',
    docNo: e.number,
    docDate: portalDate(e.date),
    fromGstin: e.from.gstin,
    fromTrdName: e.from.name,
    fromAddr1: e.from.addr1,
    fromAddr2: e.from.addr2 ?? '',
    fromPlace: e.from.place,
    fromPincode: Number(e.from.pincode),
    fromStateCode: Number(e.from.stateCode),
    actFromStateCode: Number(e.from.stateCode),
    toGstin: e.to.gstin,
    toTrdName: e.to.name,
    toAddr1: e.to.addr1,
    toAddr2: e.to.addr2 ?? '',
    toPlace: e.to.place,
    toPincode: Number(e.to.pincode),
    toStateCode: Number(e.to.stateCode),
    actToStateCode: Number(e.to.stateCode),
    transactionType: e.transactionType,
    totalValue: r2(e.values.taxablePaise),
    cgstValue: r2(e.values.cgstPaise),
    sgstValue: r2(e.values.sgstPaise),
    igstValue: r2(e.values.igstPaise),
    cessValue: r2(e.values.cessPaise),
    otherValue: r2(e.values.otherPaise),
    totInvValue: r2(e.values.totalPaise),
    transMode: rules.transModes[e.transport.mode],
    transDistance: String(e.transport.distanceKm),
    itemList: e.lines.map((l) => ({
      productName: l.name,
      hsnCode: Number(l.hsn),
      quantity: r3qty(l.qtyMicros),
      qtyUnit: l.uqc || 'OTH',
      cgstRate: pct(l.cgstRateBp),
      sgstRate: pct(l.sgstRateBp),
      igstRate: pct(l.igstRateBp),
      cessRate: pct(l.cessRateBp),
      taxableAmount: r2(l.taxablePaise),
    })),
  };
  const t = e.transport;
  if (t.transporterId) out['transporterId'] = t.transporterId;
  if (t.transporterName) out['transporterName'] = t.transporterName;
  if (t.vehicleNo) {
    out['vehicleNo'] = normaliseVehicle(t.vehicleNo);
    out['vehicleType'] = t.vehicleType === 'odc' ? 'O' : 'R';
  }
  if (t.transDocNo) out['transDocNo'] = t.transDocNo;
  if (t.transDocDate) out['transDocDate'] = portalDate(t.transDocDate);
  return out;
}

export const normaliseVehicle = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The limit that applies to a movement: the state's own inside a state, the national one otherwise. */
export function ewbThreshold(
  fromState: string,
  toState: string,
  rules: EwbRules = EWB_RULES_V1,
): number {
  // a state's own higher limit counts only once someone has checked it against the state's notification:
  // until then the national (lower) limit applies, which errs on the side of making a bill
  const own = fromState === toState ? rules.intraStateThresholds[fromState] : undefined;
  return own?.checked ? own.paise : rules.thresholdPaise;
}

/** Whether a consignment of this value needs an e-way bill. */
export function ewbRequired(
  valuePaise: number,
  fromState: string,
  toState: string,
  rules: EwbRules = EWB_RULES_V1,
): boolean {
  return valuePaise > ewbThreshold(fromState, toState, rules);
}

/** Part B (the vehicle) is not needed for a short movement inside a state to the transporter. */
export function partBRequired(
  distanceKm: number,
  sameState: boolean,
  rules: EwbRules = EWB_RULES_V1,
): boolean {
  return !(sameState && distanceKm > 0 && distanceKm <= rules.partBExemptKm);
}

/**
 * Valid until (rule 138(10)): one day for every 200 km (20 km for over-dimensional cargo) or part of it,
 * each day running to midnight of the day after the date of generation. Returns an ISO time in IST.
 */
export function ewbValidUntil(
  generatedOn: string,
  distanceKm: number,
  vehicleType: 'regular' | 'odc' = 'regular',
  rules: EwbRules = EWB_RULES_V1,
): string {
  const perDay = vehicleType === 'odc' ? rules.kmPerDay.odc : rules.kmPerDay.regular;
  const days = Math.max(1, Math.ceil(Math.max(0, distanceKm) / perDay));
  const d = new Date(`${generatedOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.toISOString().slice(0, 10)}T23:59:59+05:30`;
}

/** An e-way bill can be cancelled within 24 hours of generation. */
export function ewbCancellable(
  generatedAt: string,
  now: Date,
  rules: EwbRules = EWB_RULES_V1,
): boolean {
  const at = Date.parse(generatedAt);
  return !Number.isNaN(at) && now.getTime() - at <= rules.cancelHours * 3_600_000;
}

/** It can be extended from 8 hours before to 8 hours after it expires. */
export function ewbExtendable(
  validUntil: string,
  now: Date,
  rules: EwbRules = EWB_RULES_V1,
): boolean {
  const until = Date.parse(validUntil);
  if (Number.isNaN(until)) return false;
  const t = now.getTime();
  return (
    t >= until - rules.extendWindowHours.before * 3_600_000 &&
    t <= until + rules.extendWindowHours.after * 3_600_000
  );
}

/** What the portal would refuse in an e-way bill, before it is sent. */
export function checkEwb(e: EwbInput, rules: EwbRules = EWB_RULES_V1): EinvProblem[] {
  const out: EinvProblem[] = [];
  const add = (path: string, code: string, message: string) => out.push({ path, code, message });
  for (const [side, a] of [
    ['from', e.from],
    ['to', e.to],
  ] as const) {
    if (a.gstin !== 'URP' && !checkGstin(a.gstin).valid)
      add(
        `${side}Gstin`,
        'gstin',
        `${a.gstin || 'The GSTIN'} is not valid (use URP for an unregistered person).`,
      );
    if (!/^\d{6}$/.test(a.pincode))
      add(`${side}Pincode`, 'pincode', 'The pincode must be 6 digits.');
    if (!a.place.trim()) add(`${side}Place`, 'place', 'The place is missing.');
  }
  if (e.lines.length === 0) add('itemList', 'no_lines', 'There are no lines.');
  e.lines.forEach((l, i) => {
    if (!/^\d{4,8}$/.test(l.hsn))
      add(`itemList[${i}].hsnCode`, 'hsn', `Line ${i + 1}: the HSN must be 4 to 8 digits.`);
  });
  const t = e.transport;
  if (!Number.isInteger(t.distanceKm) || t.distanceKm < 0 || t.distanceKm > rules.maxDistanceKm)
    add(
      'transDistance',
      'distance',
      `The distance must be 0 (worked out by the portal) to ${rules.maxDistanceKm} km.`,
    );
  const sameState = e.from.stateCode === e.to.stateCode;
  if (
    t.mode === 'road' &&
    !t.vehicleNo &&
    !t.transporterId &&
    partBRequired(t.distanceKm, sameState, rules)
  )
    add(
      'vehicleNo',
      'part_b',
      'Give the vehicle number, or a transporter ID so the transporter can add it.',
    );
  if (t.vehicleNo && !rules.vehicleNumber.test(normaliseVehicle(t.vehicleNo)))
    add(
      'vehicleNo',
      'vehicle',
      `${t.vehicleNo} is not a vehicle number the portal accepts (like KA01AB1234).`,
    );
  if (
    t.transporterId &&
    !checkGstin(t.transporterId).valid &&
    !/^\d{2}[A-Z0-9]{13}$/.test(t.transporterId)
  )
    add(
      'transporterId',
      'transporter',
      'The transporter ID is a GSTIN or a 15-character transporter ID.',
    );
  if ((t.mode === 'rail' || t.mode === 'air' || t.mode === 'ship') && !t.transDocNo)
    add(
      'transDocNo',
      'trans_doc',
      'For rail, air or ship, give the transport document number and date.',
    );
  return out;
}
