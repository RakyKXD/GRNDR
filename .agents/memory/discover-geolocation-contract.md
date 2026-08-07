---
name: Discover geolocation contract
description: External contract details for the Grindr-compatible Discover search adapter.
---

The public Discover documentation uses the query key `geohash`, not `geo_hash`, and requires a 12-character geohash. The `geo_hash_decode` string appears as an internal validation error and should not be inferred as the parameter name.

**Why:** A 400 error containing `geo_hash_decode` can misleadingly suggest that the API expects a snake_case query parameter, while the documented request format uses `geohash`.

**How to apply:** Keep city and country out of geographic Discover requests; resolve them to coordinates first, encode a 12-character geohash, and send it as `?geohash=...` to the configured Discover path.