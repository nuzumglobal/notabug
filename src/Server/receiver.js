/* globals Promise */
import * as R from "ramda";
import {
  chainInterface,
  Receiver,
  deduplicateMessages,
  allowLeech,
  relayMessages,
  cluster,
  websocketTransport
} from "@notabug/gun-receiver";
import { receiver as redis } from "@notabug/gun-redis";
import { receiver as lmdb } from "@notabug/gun-lmdb";
import { Validation } from "@notabug/peer";
import { options } from "./options";

const Gun = require("gun/gun");

const suppressor = Validation.createSuppressor(Gun);

const validateMessage = ({ json, skipValidation, ...msg }) => {
  if (skipValidation) return { ...msg, json };

  return suppressor.validate(json).then(validated => {
    if (!validated) return console.error(suppressor.validate.errors, json);
    return { ...msg, json: validated };
  });
};

const redisSupport = R.pipe(
  redis.respondToGets(Gun, { disableRelay: true }),
  chainInterface,
  redis.acceptWrites(Gun, { disableRelay: false })
);

const lmdbConf = { path: options.lmdbpath, mapSize: options.lmdbmapsize };

const lmdbSupport = R.pipe(
  lmdb.respondToGets(Gun, { disableRelay: true }, lmdbConf),
  chainInterface,
  lmdb.acceptWrites(Gun, { disableRelay: false }, lmdbConf)
);

const skipValidatingKnownData = db => {
  db.onIn(msg => {
    if (msg.skipValidation || !db.get || !msg.json || !msg.json.put) return msg;
    const souls = R.keys(msg.json.put);

    if (!souls.length) return msg;
    return Promise.all(
      souls.map(soul =>
        db.get(soul, { noRelay: true }).then(existing => {
          const updated = msg.json.put[soul];

          if (!existing || !updated) return true;
          const propNames = R.without(["_"], R.keys(updated));
          const modifiedKey = propNames.find(
            name => !R.equals(existing[name], updated[name])
          );

          return modifiedKey;
        })
      )
    ).then(hasChanges => {
      if (!hasChanges.length || hasChanges.find(x => x)) return msg;
      return { ...msg, skipValidation: true };
    });
  });

  return db;
};

export default opts =>
  R.pipe(
    Receiver,
    opts.redis ? skipValidatingKnownData : R.identity,
    db => db.onIn(validateMessage) && db,
    deduplicateMessages,
    db => {
      db.onIn(msg => {
        if (msg && msg.json && (msg.json.leech || msg.json.ping || msg.json.ok)) return;
        return msg;
      });
      return db;
    },
    // allowLeech,
    opts.redis ? redisSupport : R.identity,
    opts.lmdb ? lmdbSupport : R.identity,
    relayMessages,
    cluster,
    // db => db.onOut(validateMessage) && db,
    opts.port || opts.web ? websocketTransport.server(opts) : R.identity,
    ...opts.peers.map(peer => websocketTransport.client(peer))
  )(opts);
