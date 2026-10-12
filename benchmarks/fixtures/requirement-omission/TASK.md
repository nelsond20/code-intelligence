# Specification

The `normalizeDuration` change has eight must requirements:

1. Return integer milliseconds.
2. Preserve zero.
3. Reject negative values.
4. Reject non-finite values.
5. Round fractional milliseconds down.
6. Accept numeric strings.
7. Reject empty strings.
8. Reject values above `Number.MAX_SAFE_INTEGER`.

Implement all requirements and retain requirement-to-test evidence.
