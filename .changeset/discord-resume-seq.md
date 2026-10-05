---
"@effect-uai/discord": patch
---

Gateway resumes now send the last sequence number seen. The counter was kept per connection, so every resume sent `seq: null` and Discord could not replay the events missed while disconnected.
