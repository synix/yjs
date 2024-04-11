import * as t from 'lib0/testing'
import { init, compare } from './testHelper.js' // eslint-disable-line
import * as Y from '../src/index.js'
import { readClientsStructRefs, readDeleteSet, UpdateDecoderV2, UpdateEncoderV2, writeDeleteSet } from '../src/internals.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as object from 'lib0/object'

/**
 * @typedef {Object} Enc
 * @property {function(Array<Uint8Array>):Uint8Array} Enc.mergeUpdates
 * @property {function(Y.Doc):Uint8Array} Enc.encodeStateAsUpdate
 * @property {function(Y.Doc, Uint8Array):void} Enc.applyUpdate
 * @property {function(Uint8Array):void} Enc.logUpdate
 * @property {function(Uint8Array):{from:Map<number,number>,to:Map<number,number>}} Enc.parseUpdateMeta
 * @property {function(Y.Doc):Uint8Array} Enc.encodeStateVector
 * @property {function(Uint8Array):Uint8Array} Enc.encodeStateVectorFromUpdate
 * @property {'update'|'updateV2'} Enc.updateEventName
 * @property {string} Enc.description
 * @property {function(Uint8Array, Uint8Array):Uint8Array} Enc.diffUpdate
 */

/**
 * @type {Enc}
 */
const encV1 = {
  mergeUpdates: Y.mergeUpdates,
  encodeStateAsUpdate: Y.encodeStateAsUpdate,
  applyUpdate: Y.applyUpdate,
  logUpdate: Y.logUpdate,
  parseUpdateMeta: Y.parseUpdateMeta,
  encodeStateVectorFromUpdate: Y.encodeStateVectorFromUpdate,
  encodeStateVector: Y.encodeStateVector,
  updateEventName: 'update',
  description: 'V1',
  diffUpdate: Y.diffUpdate
}

/**
 * @type {Enc}
 */
const encV2 = {
  mergeUpdates: Y.mergeUpdatesV2,
  encodeStateAsUpdate: Y.encodeStateAsUpdateV2,
  applyUpdate: Y.applyUpdateV2,
  logUpdate: Y.logUpdateV2,
  parseUpdateMeta: Y.parseUpdateMetaV2,
  encodeStateVectorFromUpdate: Y.encodeStateVectorFromUpdateV2,
  encodeStateVector: Y.encodeStateVector,
  updateEventName: 'updateV2',
  description: 'V2',
  diffUpdate: Y.diffUpdateV2
}

/**
 * @type {Enc}
 */
const encDoc = {
  mergeUpdates: (updates) => {
    const ydoc = new Y.Doc({ gc: false })
    updates.forEach(update => {
      Y.applyUpdateV2(ydoc, update)
    })
    return Y.encodeStateAsUpdateV2(ydoc)
  },
  encodeStateAsUpdate: Y.encodeStateAsUpdateV2,
  applyUpdate: Y.applyUpdateV2,
  logUpdate: Y.logUpdateV2,
  parseUpdateMeta: Y.parseUpdateMetaV2,
  encodeStateVectorFromUpdate: Y.encodeStateVectorFromUpdateV2,
  encodeStateVector: Y.encodeStateVector,
  updateEventName: 'updateV2',
  description: 'Merge via Y.Doc',
  /**
   * @param {Uint8Array} update
   * @param {Uint8Array} sv
   */
  diffUpdate: (update, sv) => {
    const ydoc = new Y.Doc({ gc: false })
    Y.applyUpdateV2(ydoc, update)
    return Y.encodeStateAsUpdateV2(ydoc, sv)
  }
}

const encoders = [encV1, encV2, encDoc]

/**
 * @param {Array<Y.Doc>} users
 * @param {Enc} enc
 */
const fromUpdates = (users, enc) => {
  const updates = users.map(user =>
    enc.encodeStateAsUpdate(user)
  )
  const ydoc = new Y.Doc()
  enc.applyUpdate(ydoc, enc.mergeUpdates(updates))
  return ydoc
}

/**
 * @param {t.TestCase} tc
 */
export const testMergeUpdates = tc => {
  const { users, array0, array1 } = init(tc, { users: 3 })
  t.compare(users.length, 3)
  t.assert(array0 instanceof Y.Array)
  t.assert(array1 instanceof Y.Array)
  t.compareArrays(array0.toArray(), [])
  t.compareArrays(array1.toArray(), [])

  array0.insert(0, [1])
  array1.insert(0, [2])

  compare(users)

  // 上一行compare()函数会将users数组里的每个doc的updates合并成一个新的doc并追加到users数组里，所以这里长度从3变成了6
  t.compare(users.length, 6)

  t.compareArrays(array0.toArray(), [1, 2])
  t.compareArrays(array1.toArray(), [1, 2])

  encoders.forEach(enc => {
    const merged = fromUpdates(users, enc)
    t.compareArrays(array0.toArray(), merged.getArray('array').toArray())
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testKeyEncoding = tc => {
  const { users, text0, text1 } = init(tc, { users: 2 })

  text0.insert(0, 'a', { italic: true })
  text0.insert(0, 'b')
  text0.insert(0, 'c', { italic: true })

  // 因为没有调用compare()函数，所以各个remote client的doc的updates还未合并
  t.compareStrings(text0.toString(), 'cba')
  t.compareStrings(text1.toString(), '')

  const update = Y.encodeStateAsUpdateV2(users[0])

  Y.applyUpdateV2(users[1], update)

  t.compareStrings(text1.toString(), 'cba')

  t.compare(text1.toDelta(), [{ insert: 'c', attributes: { italic: true } }, { insert: 'b' }, { insert: 'a', attributes: { italic: true } }])

  compare(users)

  t.compareStrings(text0.toString(), 'cba')
  t.compareStrings(text1.toString(), 'cba')
}

/**
 * @param {Y.Doc} ydoc
 * @param {Array<Uint8Array>} updates - expecting at least 4 updates
 * @param {Enc} enc
 * @param {boolean} hasDeletes
 */
const checkUpdateCases = (ydoc, updates, enc, hasDeletes) => {
  const cases = []
  // Case 1: Simple case, simply merge everything
  cases.push(enc.mergeUpdates(updates))

  // Case 2: Overlapping updates
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates(updates.slice(2)),
    enc.mergeUpdates(updates.slice(0, 2))
  ]))

  // Case 3: Overlapping updates
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates(updates.slice(2)),
    enc.mergeUpdates(updates.slice(1, 3)),
    updates[0]
  ]))

  // Case 4: Separated updates (containing skips)
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates([updates[0], updates[2]]),
    enc.mergeUpdates([updates[1], updates[3]]),
    // 下面这行代码注释掉也是可以的...
    enc.mergeUpdates(updates.slice(4))
  ]))

  // Case 5: overlapping with many duplicates
  cases.push(enc.mergeUpdates(cases))

  // const targetState = enc.encodeStateAsUpdate(ydoc)
  // t.info('Target State: ')
  // enc.logUpdate(targetState)

  cases.forEach((mergedUpdates) => {
    // t.info('State Case $' + i + ':')
    // enc.logUpdate(updates)
    const merged = new Y.Doc({ gc: false })
    enc.applyUpdate(merged, mergedUpdates)
    t.compareArrays(merged.getArray().toArray(), ydoc.getArray().toArray())
    // encodeStateVector接收的参数类型为Y.Doc，encodeStateVectorFromUpdate接收的参数类型为Uint8Array
    t.compare(enc.encodeStateVector(merged), enc.encodeStateVectorFromUpdate(mergedUpdates))

    // 只处理updateV2的情况
    if (enc.updateEventName !== 'update') { // @todo should this also work on legacy updates?
      for (let j = 1; j < updates.length; j++) {
        const partMerged = enc.mergeUpdates(updates.slice(j))
        const partMeta = enc.parseUpdateMeta(partMerged)

        const targetSV = Y.encodeStateVectorFromUpdateV2(Y.mergeUpdatesV2(updates.slice(0, j)))
        const diffed = enc.diffUpdate(mergedUpdates, targetSV)
        const diffedMeta = enc.parseUpdateMeta(diffed)
        // 比较通过上述两种方法计算出来的一部分updates的meta信息是一致的
        t.compare(partMeta, diffedMeta)

        // 对下面这个代码块无语了...
        {
          // We can'd do the following
          //  - t.compare(diffed, mergedDeletes)
          // because diffed contains the set of all deletes.
          // So we add all deletes from `diffed` to `partDeletes` and compare then
          const decoder = decoding.createDecoder(diffed)
          const updateDecoder = new UpdateDecoderV2(decoder)
          readClientsStructRefs(updateDecoder, new Y.Doc())
          const ds = readDeleteSet(updateDecoder)
          const updateEncoder = new UpdateEncoderV2()
          encoding.writeVarUint(updateEncoder.restEncoder, 0) // 0 structs
          writeDeleteSet(updateEncoder, ds)
          const deletesUpdate = updateEncoder.toUint8Array()
          const mergedDeletes = Y.mergeUpdatesV2([deletesUpdate, partMerged])
          if (!hasDeletes || enc !== encDoc) {
            // deletes will almost definitely lead to different encoders because of the mergeStruct feature that is present in encDoc
            t.compare(diffed, mergedDeletes)
          }
        }
      }
    }

    const meta = enc.parseUpdateMeta(mergedUpdates)
    t.assert(meta.from instanceof Map)
    // from的clock是0
    meta.from.forEach((clock, client) => t.assert(clock === 0))

    t.assert(meta.to instanceof Map)
    // to的clock是4
    meta.to.forEach((clock, client) => {
      const structs = /** @type {Array<Y.Item>} */ (merged.store.clients.get(client))
      const lastStruct = structs[structs.length - 1]
      // clock是这么计算得来的? 还是说要和这里保持一致性？
      t.assert(lastStruct.id.clock + lastStruct.length === clock)
    })
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeUpdates1 = _tc => {
  encoders.forEach((enc) => {
    t.info(`Using encoder: ${enc.description}`)
    const ydoc = new Y.Doc({ gc: false })
    const updates = /** @type {Array<Uint8Array>} */ ([])
    ydoc.on(enc.updateEventName, update => { updates.push(update) })

    const array = ydoc.getArray()
    array.insert(0, [1])
    array.insert(0, [2])
    array.insert(0, [3])
    array.insert(0, [4])

    t.compare(updates.length, 4)
    checkUpdateCases(ydoc, updates, enc, false)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testMergeUpdates2 = tc => {
  encoders.forEach((enc, i) => {
    t.info(`Using encoder: ${enc.description}`)
    const ydoc = new Y.Doc({ gc: false })
    const updates = /** @type {Array<Uint8Array>} */ ([])
    ydoc.on(enc.updateEventName, update => { updates.push(update) })

    const array = ydoc.getArray()
    array.insert(0, [1, 2])
    array.delete(1, 1)
    array.insert(0, [3, 4])
    array.delete(1, 2)

    checkUpdateCases(ydoc, updates, enc, true)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testMergePendingUpdates = tc => {
  const yDoc = new Y.Doc()
  /**
   * @type {Array<Uint8Array>}
   */
  const serverUpdates = []
  yDoc.on('update', (update, origin, c) => {
    serverUpdates.splice(serverUpdates.length, 0, update)
  })
  const yText = yDoc.getText('textBlock')
  yText.applyDelta([{ insert: 'r' }])
  yText.applyDelta([{ insert: 'o' }])
  yText.applyDelta([{ insert: 'n' }])
  yText.applyDelta([{ insert: 'e' }])
  yText.applyDelta([{ insert: 'n' }])

  const yDoc1 = new Y.Doc()
  Y.applyUpdate(yDoc1, serverUpdates[0])
  const update1 = Y.encodeStateAsUpdate(yDoc1)

  const yDoc2 = new Y.Doc()
  Y.applyUpdate(yDoc2, update1)
  Y.applyUpdate(yDoc2, serverUpdates[1])
  const update2 = Y.encodeStateAsUpdate(yDoc2)

  const yDoc3 = new Y.Doc()
  Y.applyUpdate(yDoc3, update2)
  Y.applyUpdate(yDoc3, serverUpdates[3])
  const update3 = Y.encodeStateAsUpdate(yDoc3)

  const yDoc4 = new Y.Doc()
  Y.applyUpdate(yDoc4, update3)
  Y.applyUpdate(yDoc4, serverUpdates[2])
  const update4 = Y.encodeStateAsUpdate(yDoc4)

  const yDoc5 = new Y.Doc()
  Y.applyUpdate(yDoc5, update4)
  Y.applyUpdate(yDoc5, serverUpdates[4])
  // @ts-ignore
  const _update5 = Y.encodeStateAsUpdate(yDoc5) // eslint-disable-line

  const yText5 = yDoc5.getText('textBlock')
  t.compareStrings(yText5.toString(), 'nenor')
}

/**
 * @param {t.TestCase} _tc
 */
export const testObfuscateUpdates = _tc => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('text')
  const ymap = ydoc.getMap('map')
  const yarray = ydoc.getArray('array')
  // test ytext
  ytext.applyDelta([{ insert: 'text', attributes: { bold: true } }, { insert: { href: 'supersecreturl' } }])
  // test ymap
  ymap.set('key', 'secret1')
  ymap.set('key', 'secret2')
  // test yarray with subtype & subdoc
  const subtype = new Y.XmlElement('secretnodename')
  const subdoc = new Y.Doc({ guid: 'secret' })
  subtype.setAttribute('attr', 'val')
  yarray.insert(0, ['teststring', 42, subtype, subdoc])
  // obfuscate the content and put it into a new document
  const obfuscatedUpdate = Y.obfuscateUpdate(Y.encodeStateAsUpdate(ydoc))
  const odoc = new Y.Doc()
  Y.applyUpdate(odoc, obfuscatedUpdate)
  const otext = odoc.getText('text')
  const omap = odoc.getMap('map')
  const oarray = odoc.getArray('array')
  // test ytext
  const delta = otext.toDelta()
  t.assert(delta.length === 2)
  t.assert(delta[0].insert !== 'text' && delta[0].insert.length === 4)
  t.assert(object.length(delta[0].attributes) === 1)
  t.assert(!object.hasProperty(delta[0].attributes, 'bold'))
  t.assert(object.length(delta[1]) === 1)
  t.assert(object.hasProperty(delta[1], 'insert'))
  // test ymap
  t.assert(omap.size === 1)
  t.assert(!omap.has('key'))
  // test yarray with subtype & subdoc
  const result = oarray.toArray()
  t.assert(result.length === 4)
  t.assert(result[0] !== 'teststring')
  t.assert(result[1] !== 42)
  const osubtype = /** @type {Y.XmlElement} */ (result[2])
  const osubdoc = result[3]
  // test subtype
  t.assert(osubtype.nodeName !== subtype.nodeName)
  t.assert(object.length(osubtype.getAttributes()) === 1)
  t.assert(osubtype.getAttribute('attr') === undefined)
  // test subdoc
  t.assert(osubdoc.guid !== subdoc.guid)
}


/**
 * @param {t.TestCase} _tc
 */
export const testUpdateDecoderV2 = _tc => {
  const ydoc0 = new Y.Doc()
  const array0 = ydoc0.getArray('array')
  array0.insert(0, ['a'])

  const update = Y.encodeStateAsUpdateV2(ydoc0)

  Y.logUpdateV2(update)

  const decoder = decoding.createDecoder(update)
  const updateDecoder = new UpdateDecoderV2(decoder)

  // Decode state update
  const numOfStateUpdates = decoding.readVarInt(updateDecoder.restDecoder)
  t.compare(numOfStateUpdates, 1)

  // Decode update array, which contains only one update
  const numOfStructs = decoding.readVarUint(updateDecoder.restDecoder)
  t.compare(numOfStructs, 1)
  const client = updateDecoder.readClient()
  t.compare(client, ydoc0.clientID)
  const clock = decoding.readVarUint(updateDecoder.restDecoder)
  t.compare(clock, 0)

  // Decode struct array, which contains only one struct
  const info = updateDecoder.readInfo()
  t.compare(info, 8) // 8 is ContentAny
  const len = updateDecoder.readLen()
  t.compare(len, 1)
  const content = updateDecoder.readAny()
  t.compare(content, 'a')
}

/**
 * @param {t.TestCase} _tc
 */
export const testReadClientsStructRefs = _tc => {
  const ydoc0 = new Y.Doc()
  const array0 = ydoc0.getArray('array')
  array0.insert(0, ['a'])

  const update = Y.encodeStateAsUpdateV2(ydoc0)

  const decoder = decoding.createDecoder(update)
  const updateDecoder = new UpdateDecoderV2(decoder)

  const ydoc1 = new Y.Doc()
  const clientsStructRefs = readClientsStructRefs(updateDecoder, ydoc1)

  t.assert(clientsStructRefs instanceof Map)
  t.assert(clientsStructRefs.size === 1)
  const ref = clientsStructRefs.get(ydoc0.clientID)
  t.compare(ref?.i, 0)
  t.assert(ref?.refs instanceof Array)
  t.compare(ref?.refs.length, 1)

  t.assert(ref?.refs[0] instanceof Y.Item)
  t.compareObjects(ref?.refs[0].id, Y.createID(ydoc0.clientID, 0))
  // @ts-ignore
  t.assert(ref?.refs[0].content instanceof Y.ContentAny)
  // @ts-ignore
  t.compare(ref?.refs[0].content.arr, ['a'])
}
