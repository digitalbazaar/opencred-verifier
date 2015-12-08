/*!
 * Open Credential Verification Tool.
 *
 * Copyright (c) 2014-2015 Digital Bazaar, Inc. All rights reserved.
 *
 * @author Dave Longley
 * @author David I. Lehn
 */
(function(global) {

'use strict';

// determine if using node.js or browser
var _nodejs = (
  typeof process !== 'undefined' && process.versions && process.versions.node);
var _browser = !_nodejs &&
  (typeof window !== 'undefined' || typeof self !== 'undefined');

/**
 * Attaches the Open Credential verifier API to the given object.
 *
 * @param api the object to attach the verifier API to.
 * @param [options] the options to use:
 *          [inject] the dependencies to inject, available global defaults will
 *            be used otherwise.
 *            [forge] forge API.
 *            [jsonld] jsonld.js API; a secure document loader must be
 *              configured.
 *            [_] underscore API.
 *          [disableLocalFraming] true to disable framing of local
 *            documents based on the given local base URI (default: false).
 *          [localBaseUri] must be given if disabling local framing.
 */
function wrap(api, options) {

// handle dependency injection
options = options || {};
var inject = options.inject || {};
var forge = inject.forge || global.forge;
var jsonld = inject.jsonld || global.jsonldjs;
var _ = inject._ || global._;

// if dependencies not loaded and using node, load them
if(_nodejs) {
  if(!forge) {
    forge = require('node-forge');
  }
  if(!jsonld) {
    // locally configure jsonld
    jsonld = require('jsonld')();
    jsonld.useDocumentLoader('node', {secure: true});
  }
  if(!_){
    _ = require('underscore');
  }
}

var CONTEXT_URL = 'https://w3id.org/credentials/v1';

/**
 * Attempts to verify the given credential using the Open Credential
 * verification algorithm.
 *
 * @param credential the credential (JSON-LD object) or URL to the credential
 *          to verify.
 *
 * @return a promise that resolves to a results object with the parameters
 *           used during verification, any errors, and any tests that were run.
 */
api.verifyCredential = function(credential) {
  return _getCredentialParams(credential).then(function(results) {
    var params = results.params;
    params.hasExpiration = false;

    var tests = results.tests = {};
    tests.signed = false;
    tests.publicKeyOwner = false;
    tests.signatureVerified = false;
    tests.notExpired = true;
    tests.verified = false;

    // test if signature present
    tests.signed = !!params.signature;

    // done if no signature to check
    if(!tests.signed) {
      return results;
    }

    // check if publicKey retrieved
    tests.publicKeyAccessible = !!params.publicKey;

    // ensure identity owns public key
    if(params.publicKey && params.identity) {
      var ownedKeys = jsonld.getValues(params.identity, 'publicKey');
      ownedKeys.forEach(function(key) {
        if(typeof key === 'string' && key === params.publicKey.id) {
          tests.publicKeyOwner = true;
        } else if(key.id === params.publicKey.id) {
          tests.publicKeyOwner = true;
        }
      });
    }

    // ensure known signature type
    var hasGraphSignature2012 = false;
    if(params.signature.type === 'GraphSignature2012') {
      hasGraphSignature2012 = true;
      tests.knownSignatureType = true;
    }
    var hasLinkedDataSignature2015 = false;
    if(params.signature.type === 'LinkedDataSignature2015') {
      hasLinkedDataSignature2015 = true;
      tests.knownSignatureType = true;
    }

    if(params.publicKey) {
      // ensure key is not revoked
      tests.publicKeyNotRevoked = !('revoked' in params.publicKey);
    }

    if(params.publicKey && params.normalized) {
      // verify signature for known signature types
      var publicKey = forge.pki.publicKeyFromPem(
        params.publicKey.publicKeyPem);
      var md = forge.md.sha256.create();
      var signedData = '';
      if(hasGraphSignature2012) {
        if('nonce' in params.signature) {
          signedData += params.signature.nonce;
        }
        signedData += params.signature.created;
        signedData += params.normalized;
      }
      if(hasLinkedDataSignature2015) {
        // headers are lexicographical order
        var headers = [
          ['http://purl.org/dc/elements/1.1/created', params.signature.created],
          ['https://w3id.org/security#domain', params.signature.domain],
          ['https://w3id.org/security#nonce', params.signature.nonce]
        ];
        for(var i = 0; i < headers.length; ++i) {
          var header = headers[i];
          if(header[1] !== null && header[1] !== undefined) {
            signedData += header[0] + ': ' + header[1] + '\n';
          }
        }
        signedData += params.normalized;
      }
      if(tests.knownSignatureType) {
        params.signedData = signedData;
        md.update(signedData, 'utf8');
        var signature = forge.util.decode64(params.signature.signatureValue);
        try {
          tests.signatureVerified = publicKey.verify(
            md.digest().getBytes(), signature);
          // set error if no match
          if(!tests.signatureVerified) {
            throw new Error('Signature value incorrect.');
          }
        } catch(e) {
          tests.signatureVerified = false;
          results.errors.signature = e;
        }
      }
    }

    if(!params.data) {
      return results;
    }

    // check expiration date, if present
    if('expires' in params.data) {
      params.hasExpiration = true;
      params.expiration = new Date(params.data.expires);
      tests.notExpired = (params.expiration > new Date());
    }

    // verified if all tests pass
    tests.verified = true;
    tests.verified = tests.signed && _.chain(_.values(tests)).all().value();

    // ensure data is compacted (remove non-context properties from local data)
    return jsonld.promises().compact(params.data, CONTEXT_URL)
      .then(function(data) {
        params.verifiedData = data;
        return results;
      })
      .catch(function(err) {
        results.errors.compact = err;
        return results;
      });
  });
};

/**
 * Gets all of the credential parameters required to verify the given data.
 * Some parameters may be fetched via the Web.
 *
 * @param data the data to verify; may be a URL or JSON-LD object.
 *
 * @return a promise that resolves to a results object:
 *           {params: <the verification parameters>, errors: <any errors>}
 */
function _getCredentialParams(data) {
  var FRAME_SIGNED_OBJECT = {
    '@context': CONTEXT_URL,
    signature: {'@embed': true}
  };
  var FRAME_PUBLIC_KEY = {
    '@context': CONTEXT_URL,
    type: 'CryptographicKey',
    owner: {'@embed': false},
    publicKeyPem: {}
  };
  // https://w3id.org/identity#Identity
  var FRAME_IDENTITY = {
    '@context': CONTEXT_URL,
    type: 'Identity',
    publicKey: {
      '@embed': false,
      '@default': []
    }
  };
  // https://w3id.org/openbadges#Identity
  var FRAME_OB_IDENTITY = {
    '@context': 'https://w3id.org/openbadges/v1',
    type: 'Identity',
    publicKey: {
      '@embed': false,
      '@default': []
    }
  };

  // frame data to get access to signature
  var results = {};
  var params = results.params = {};
  var errors = results.errors = {};
  return _frame(data, FRAME_SIGNED_OBJECT)
    // FIXME: validate signature fields
    .catch(function(err) {
      errors.data = err;
      throw results;
    })
    .then(function(data) {
      // save and remove signature
      params.data = data;
      params.signature = params.data.signature;
      delete params.data.signature;

      // get signer's public key
      return _getJson(params.signature.creator)
        .then(function(publicKey) {
          // frame public key to get access to owner
          return _frame(publicKey, FRAME_PUBLIC_KEY);
        })
        .catch(function(err) {
          errors.publicKey = err;
          throw results;
        });
    })
    .then(function(publicKey) {
      // get identity that owns public key
      params.publicKey = publicKey;
      return _getJson(publicKey.owner)
        .then(function(identity) {
          // frame identity
          return _frame(identity, FRAME_IDENTITY)
            .catch(function(err) {
              // FIXME
              return _frame(identity, FRAME_OB_IDENTITY);
            })
            .then(function(identity) {
              params.identity = identity;
            });
        })
        .catch(function(err) {
          errors.publicKeyOwner = err;
        });
    })
    .then(function() {
      // normalize
      var options = {
        format: 'application/nquads'
      };
      // set algorithm for known types, else leave as default
      if(params.signature.type === 'GraphSignature2012') {
        options.algorithm = 'URGNA2012';
      } else if(params.signature.type === 'LinkedDataSignature2015') {
        options.algorithm = 'URDNA2015';
      }
      return jsonld.promises().normalize(params.data, options)
        .then(function(normalized) {
          params.normalized = normalized;
        })
        .catch(function(err) {
          errors.normalization = err;
          throw results;
        });
    })
    // always return results
    .then(function() {return results;})
    .catch(function() {return results;});
}

/**
 * JSON-LD frame some input using the given frame; the returned promise
 * resolves to the first matching result.
 *
 * @param input the input to frame.
 * @param frame the frame to use.
 *
 * @return a promise that resolves to the first frame match; rejects
 *           otherwise.
 */
function _frame(input, frame) {
  var api = jsonld.promises();
  var promise;
  if(options.disableLocalFraming && options.localBaseUri) {
    // skip framing if data is local, assume framed properly
    if(typeof input === 'string') {
      if(input.indexOf(options.localBaseUri) === 0) {
        promise = _getJson(input);
      }
    } else if('id' in input && input.id.indexOf(options.localBaseUri) === 0) {
      promise = jsonld.Promise.resolve(input);
    }
  }
  // local framing not disabled or input is not local; do regular framing
  if(!promise) {
    // frame with null base
    var ctx = frame['@context'];
    frame['@context'] = [ctx, {'@base': null}];
    promise = api.frame(input, frame).then(function(framed) {
      var output = framed['@graph'][0];
      if(!output) {
        throw new Error('No matching object found for frame.');
      }
      output['@context'] = ctx;
      return output;
    });
  }
  return promise;
}

function _getJson(url) {
  return new jsonld.Promise(function(resolve, reject) {
    var promise = jsonld.documentLoader(url, function(err, remoteDoc) {
      if(err) {
        return reject(err);
      }
      resolve(remoteDoc);
    });
    if(promise) {
      promise.then(resolve, reject);
    }
  }).then(function(response) {
    if(typeof response.document === 'string') {
      response.document = JSON.parse(response.document);
    }
    return response.document;
  });
}

return api;

} // end wrap

// used to generate a new verifier API instance
var factory = function(inject) {
  return wrap(function() {return factory();}, inject);
};
wrap(factory);

if(_nodejs) {
  // export nodejs API
  module.exports = factory;
} else if(typeof define === 'function' && define.amd) {
  // export AMD API
  define([], function() {
    return factory;
  });
} else if(_browser) {
  // export simple browser API
  if(typeof global.opencred === 'undefined') {
    global.opencred = {};
  }
  wrap(global.opencred);
}

})(this);
