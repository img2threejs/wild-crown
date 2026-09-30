# Campaign state — Astra review round 02

The first repair fixed the eight separate regional obligation facts and added the replay discriminator at the real checkpoint-import entry. Astra then reviewed the changed source and exercised the compiled package again.

## Remaining failures reproduced

```text
canopy-representative { id: 'sable', source: 'envoy', present: true, willing: false }
luma-dominion rejected Unknown leader: luma
cross-faction-envoy-import true
```

- Canopy still used Sable, a Pack envoy, instead of Koro.
- The public type allowed Luma and leadership could transition to Luma, but Dominion validation used only the default-leader map and rejected her.
- `validFaction` accepted arbitrary envoy IDs except one special-cased Solkar spelling; a Ghor-as-Canopy-envoy checkpoint was accepted by the actual importer.
- An exiled leader with an explicitly absent/unwilling representative must remain a valid incomplete world state that can be checkpointed. Validation and eligibility must not be conflated: absence blocks the ending, not all saving before a council is selected.

These corrections were returned to Luna with canonical-representation, Luma-Dominion and absent-representative checkpoint scenarios. The unused region-to-obligation mapping was also identified for removal. No feature acceptance or publication was granted at this revision.

Scope remains the in-memory campaign package and its checkpoint envelope, not browser persistence or a full-save history transport.
