/**
 * Temperature refusals. A real gateway answered
 *   "Unsupported parameter: 'temperature' is not supported with this model."
 * and the run died. Reasoning models refuse it, gateways rename models freely, so the fact has to
 * be learned from the refusal rather than hardcoded in a list that would rot.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { isTemperatureRefusal } from './providers.ts'

test('the wording actually seen in the wild is recognised', () => {
  assert.equal(
    isTemperatureRefusal(`{"error":{"message":"Unsupported parameter: 'temperature' is not supported with this model.","type":"invalid_request_error","param":"temperature"}}`),
    true,
  )
})

test('the other phrasings gateways use are recognised too', () => {
  for (const body of [
    'temperature is not supported',
    "Unknown parameter: 'temperature'",
    'This model does not support temperature',
    'Unrecognized request argument supplied: temperature',
    'UNSUPPORTED PARAMETER: TEMPERATURE',
  ]) {
    assert.equal(isTemperatureRefusal(body), true, body)
  }
})

test('an unrelated failure is NOT mistaken for a temperature refusal', () => {
  // Retrying these without temperature would hide the real cause behind a second identical error.
  for (const body of [
    '{"error":{"message":"Incorrect API key provided"}}',
    'rate limit exceeded',
    'model not found',
    'context length exceeded: 200000 tokens',
    '',
    'temperature must be between 0 and 2', // a range complaint: the parameter IS supported
  ]) {
    assert.equal(isTemperatureRefusal(body), false, body)
  }
})
