'use strict';

/**
 * Minimal in-memory stand-in for the Mongoose models the controller uses.
 * Supports exactly the operations the controller performs: create, findOne,
 * find (+ .sort/.lean), findOneAndUpdate (plain, dotted and $inc updates),
 * updateMany, and the $nin / $gte query operators.
 */

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, cond]) => {
    const v = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('$nin' in cond && cond.$nin.includes(v)) return false;
      if ('$in' in cond && !cond.$in.includes(v)) return false;
      if ('$gte' in cond && !(v >= cond.$gte)) return false;
      return true;
    }
    return v === cond;
  });
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] = cur[p] || {};
  cur[parts.at(-1)] = value;
}
function getPath(obj, dotted) { return dotted.split('.').reduce((o, k) => (o ? o[k] : undefined), obj); }

function applyUpdate(doc, update) {
  for (const [k, v] of Object.entries(update)) {
    if (k === '$inc') for (const [p, n] of Object.entries(v)) setPath(doc, p, (getPath(doc, p) || 0) + n);
    else setPath(doc, k, v);
  }
}

function makeModel(defaults = () => ({})) {
  const docs = [];
  const query = (list) => {
    let result = list;
    const q = {
      sort(spec) {
        const [[key, dir]] = Object.entries(spec);
        result = [...result].sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * dir);
        return q;
      },
      lean() { return q; },
      then(res, rej) { return Promise.resolve(result).then(res, rej); },
    };
    return q;
  };
  const model = {
    docs,
    _failNext: null,
    reset() { docs.length = 0; model._failNext = null; },
    async create(data) {
      if (model._failNext) { const e = model._failNext; model._failNext = null; throw e; }
      const doc = { ...defaults(), ...data, createdAt: new Date(), updatedAt: new Date() };
      docs.push(doc);
      return doc;
    },
    async findOne(q) { return docs.find((d) => matches(d, q)) || null; },
    find(q) { return query(docs.filter((d) => matches(d, q))); },
    async findOneAndUpdate(q, update) {
      const doc = docs.find((d) => matches(d, q));
      if (doc) { applyUpdate(doc, update); doc.updatedAt = new Date(); }
      return doc || null;
    },
    async updateMany(q, update) {
      const hit = docs.filter((d) => matches(d, q));
      hit.forEach((d) => applyUpdate(d, update));
      return { modifiedCount: hit.length };
    },
  };
  return model;
}

module.exports = {
  makeModel,
  taskModel: () => makeModel(() => ({ status: 'pending', metadata: { totalModules: 0, completedModules: 0, totalIterations: 0 }, error: null, finalOutput: null, resumeCount: 0, modules: [] })),
  moduleModel: () => makeModel(() => ({ status: 'pending', validationPassed: false, usedFallback: false, qualityScore: 0, iteration: 0, dependencies: [] })),
  plainModel: () => makeModel(),
};
