opencred-verifier
=================

Open Credentials Verifier JavaScript API

Installation
------------

    npm install opencred-verifier

Examples
--------

```js

// verify a credential
var verifier = require('opencred-verifier');
verifier.verifyCredential(credential).then(function(results) {
  console.log('results', results);
  console.log('verified', results.tests.verified);
});
```
