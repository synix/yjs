/**
 * @module encoding
 */
/*
 * We use the first five bits in the info flag for determining the type of the struct.
 *
 * 0: GC
 * 1: Item with Deleted content
 * 2: Item with JSON content
 * 3: Item with Binary content
 * 4: Item with String content
 * 5: Item with Embed content (for richtext content)
 * 6: Item with Format content (a formatting marker for richtext content)
 * 7: Item with Type
 */

import {
  findIndexSS,
  getState,
  createID,
  getStateVector,
  readAndApplyDeleteSet,
  writeDeleteSet,
  createDeleteSetFromStructStore,
  transact,
  readItemContent,
  UpdateDecoderV1,
  UpdateDecoderV2,
  UpdateEncoderV1,
  UpdateEncoderV2,
  DSEncoderV2,
  DSDecoderV1,
  DSEncoderV1,
  mergeUpdates,
  mergeUpdatesV2,
  Skip,
  diffUpdateV2,
  convertUpdateFormatV2ToV1,
  DSDecoderV2, Doc, Transaction, GC, Item, StructStore // eslint-disable-line
} from '../internals.js'

import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as binary from 'lib0/binary'
import * as map from 'lib0/map'
import * as math from 'lib0/math'
import * as array from 'lib0/array'

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Array<GC|Item>} structs All structs by `client`
 * @param {number} client
 * @param {number} clock write structs starting with `ID(client,clock)`
 *
 * @function
 */
const writeStructs = (encoder, structs, client, clock) => {
  // write first id
  clock = math.max(clock, structs[0].id.clock) // make sure the first id exists
  const startNewStructs = findIndexSS(structs, clock)
  // write # encoded structs
  encoding.writeVarUint(encoder.restEncoder, structs.length - startNewStructs)
  encoder.writeClient(client)
  encoding.writeVarUint(encoder.restEncoder, clock)
  const firstStruct = structs[startNewStructs]
  // write first struct with an offset
  firstStruct.write(encoder, clock - firstStruct.id.clock)
  for (let i = startNewStructs + 1; i < structs.length; i++) {
    structs[i].write(encoder, 0)
  }
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {StructStore} store
 * @param {Map<number,number>} _sm
 * 
 * 这个函数是以_sm为基准，把store里新增的Item/Skip/GC实例写入到encoder里
 *
 * @private
 * @function
 */
export const writeClientsStructs = (encoder, store, _sm) => {
  // we filter all valid _sm entries into sm

  // sm这个map里存的是client id和clock的对应关系，如果client id存在新增
  const sm = new Map()

  _sm.forEach((clock, client) => {
    // only write if new structs are available
    // 如果ydoc的StructStore里对应clientId的clock比传入的_sm中的值大，说明是有新增struct的
    if (getState(store, client) > clock) {
      sm.set(client, clock)
    }
  })

  getStateVector(store).forEach((_clock, client) => {
    if (!_sm.has(client)) {
      // 如果_sm里就没有该client, 则该client从clock 0开始的struct都要写入到sm
      sm.set(client, 0)
    }
  })
  // write # states that were updated
  encoding.writeVarUint(encoder.restEncoder, sm.size)

  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  // client id的值从大到小排序

  // 这里a[0], b[0]是sm的key, 也就是client id
  array.from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    writeStructs(encoder, /** @type {Array<GC|Item>} */ (store.clients.get(client)), client, clock)
  })
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder The decoder object to read data from.
 * @param {Doc} doc
 * @return {Map<number, { i: number, refs: Array<Item | GC> }>}
 * 
 * 返回值是一个map，key是client id，value是一个对象，包含i和refs两个字段(i代表refs数组下一个待处理的数组index, 初始值为0)
 * 从readClientsStructRefs()返回时, i等于0，refs数组里Item对象的origin/rightOrigin字段是remote传入的，而left/right字段remote是未传入的, 所以是未赋值的
 *
 * @private
 * @function
 */
export const readClientsStructRefs = (decoder, doc) => {
  /**
   * @type {Map<number, { i: number, refs: Array<Item | GC> }>}
   */

  const clientRefs = map.create()
  const numOfStateUpdates = decoding.readVarUint(decoder.restDecoder)
  // 先遍历所有的update
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoding.readVarUint(decoder.restDecoder)
    /**
     * @type {Array<GC|Item>}
     */
    const refs = new Array(numberOfStructs)
    const client = decoder.readClient()
    // 这个clock代表struct数组里第一个元素的clock
    let clock = decoding.readVarUint(decoder.restDecoder)
    // const start = performance.now()
    clientRefs.set(client, { i: 0, refs })

    // 再遍历一个update里的所有struct
    for (let i = 0; i < numberOfStructs; i++) {
      const info = decoder.readInfo()
      switch (binary.BITS5 & info) {
        case 0: { // GC
          const len = decoder.readLen()
          refs[i] = new GC(createID(client, clock), len)
          clock += len
          break
        }
        case 10: { // Skip Struct (nothing to apply)
          // @todo we could reduce the amount of checks by adding Skip struct to clientRefs so we know that something is missing.
          const len = decoding.readVarUint(decoder.restDecoder)
          refs[i] = new Skip(createID(client, clock), len)
          clock += len
          break
        }
        default: { // Item with content
          /**
           * The optimized implementation doesn't use any variables because inlining variables is faster.
           * Below a non-optimized version is shown that implements the basic algorithm with
           * a few comments
           */
          const cantCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
          // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
          // and we read the next string as parentYKey.
          // It indicates how we store/retrieve parent from `y.share`
          // @type {string|null}
          const struct = new Item(
            createID(client, clock),
            null, // left
            (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null, // origin
            null, // right
            (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null, // right origin
            cantCopyParentInfo ? (decoder.readParentInfo() ? doc.get(decoder.readString()) : decoder.readLeftID()) : null, // parent
            cantCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null, // parentSub
            readItemContent(decoder, info) // item content
          )

          /* A non-optimized implementation of the above algorithm:

          // The item that was originally to the left of this item.
          const origin = (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null
          // The item that was originally to the right of this item.
          const rightOrigin = (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null
          const cantCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
          const hasParentYKey = cantCopyParentInfo ? decoder.readParentInfo() : false
          // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
          // and we read the next string as parentYKey.
          // It indicates how we store/retrieve parent from `y.share`
          // @type {string|null}
          const parentYKey = cantCopyParentInfo && hasParentYKey ? decoder.readString() : null

          const struct = new Item(
            createID(client, clock),
            null, // left
            origin, // origin
            null, // right
            rightOrigin, // right origin
            cantCopyParentInfo && !hasParentYKey ? decoder.readLeftID() : (parentYKey !== null ? doc.get(parentYKey) : null), // parent
            cantCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null, // parentSub
            readItemContent(decoder, info) // item content
          )
          */

          refs[i] = struct
          // 递增clock
          clock += struct.length
        }
      }
    }
    // console.log('time to read: ', performance.now() - start) // @todo remove
  }
  return clientRefs
}

/**
 * Resume computing structs generated by struct readers.
 *
 * While there is something to do, we integrate structs in this order
 * 1. top element on stack, if stack is not empty
 * 2. next element from current struct reader (if empty, use next struct reader)
 *
 * If struct causally depends on another struct (ref.missing), we put next reader of
 * `ref.id.client` on top of stack.
 *
 * At some point we find a struct that has no causal dependencies,
 * then we start emptying the stack.
 *
 * It is not possible to have circles: i.e. struct1 (from client1) depends on struct2 (from client2)
 * depends on struct3 (from client1). Therefore the max stack size is equal to `structReaders.length`.
 *
 * This method is implemented in a way so that we can resume computation if this update
 * causally depends on another update.
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {Map<number, { i: number, refs: (GC | Item)[] }>} clientsStructRefs
 * @return { null | { update: Uint8Array, missing: Map<number,number> } }
 *
 * @private
 * @function
 */
const integrateStructs = (transaction, store, clientsStructRefs) => {
  /**
   * @type {Array<Item | GC>}
   * 
   * stack是一个Item/GC对象缓存
   * 当把Item/GC实例integrate到本地Doc时, 发现本地有缺失(中间操作缺失或依赖缺失), 则放入stack缓存
   */
  const stack = []

  // sort them so that we take the higher id first, in case of conflicts the lower id will probably not conflict with the id from the higher user.
  // clientsStructRefsIds里client id是递增排序的
  let clientsStructRefsIds = array.from(clientsStructRefs.keys()).sort((a, b) => a - b)
  if (clientsStructRefsIds.length === 0) {
    return null
  }

  const getNextStructTarget = () => {
    if (clientsStructRefsIds.length === 0) {
      return null
    }

    // clientsStructRefsIds[clientsStructRefsIds.length - 1] 是值最大的client id
    let nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */ (clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]))

    // 从clientsStructRefs里寻找下一个未处理完的

    // 说明structRefs.i从0开始递增, 递增到structRefs.refs.length为止
    // nextStructsTarget.refs.length === nextStructsTarget.i <- 这个条件表示已处理完
    while (nextStructsTarget.refs.length === nextStructsTarget.i) {
      // 把值最大的client id从clientsStructRefsIds中删除掉, 然后nextStructsTarget赋值成下一个值最大的client id
      clientsStructRefsIds.pop()
      if (clientsStructRefsIds.length > 0) {
        nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */ (clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]))
      } else {
        return null
      }
    }

    return nextStructsTarget
  }

  let curStructsTarget = getNextStructTarget()
  if (curStructsTarget === null) {
    return null
  }

  /**
   * @type {StructStore}
   * 
   * 经过下面的white循环, clientsStructRefs里处理到的，也就是未执行integrate的Item/GC对象
   */
  const restStructs = new StructStore()

  // 在下述white循环里, 记录某个client因为某个clock值未满足预期而导致本地有缺失(Missing)
  // client id -> clock 对应关系
  const missingSV = new Map()
  /**
   * @param {number} client
   * @param {number} clock
   */
  const updateMissingSv = (client, clock) => {
    const mclock = missingSV.get(client)
    if (mclock == null || mclock > clock) {
      missingSV.set(client, clock)
    }
  }
  /**
   * @type {GC|Item}
   * clientsStructRefs里，每个client对应的i都初始化为0，这里是获取该client的refs数组里是下一个Item对象
   * 
   */
  let stackHead = /** @type {any} */ (curStructsTarget).refs[/** @type {any} */ (curStructsTarget).i++]

  // caching the state because it is used very often
  // state这个map的key是client id, value是本地doc(也就是本地StructStore)对应client的下个clock值，用来对本地doc的State Vector进行缓存
  const state = new Map()

  const addStackToRestSS = () => {
    // 把stack里缓存的Item/GC对象, 放入restStructs里
    for (const item of stack) {
      const client = item.id.client
      const inapplicableItems = clientsStructRefs.get(client)
      // 无论if还是else，处理完都说明 clientsStructRefs 已经没有client id了
      if (inapplicableItems) {
        // decrement because we weren't able to apply previous operation
        inapplicableItems.i--
        // 把未处理到的Item/GC对象放入restStructs.clients
        restStructs.clients.set(client, inapplicableItems.refs.slice(inapplicableItems.i))
        // 把对应client id从clientsStructRefs这个map里清除掉
        clientsStructRefs.delete(client)
        inapplicableItems.i = 0
        inapplicableItems.refs = []
      } else {
        // item was the last item on clientsStructRefs and the field was already cleared. Add item to restStructs and continue
        restStructs.clients.set(client, [item])
      }

      // 这里更新完 clientsStructRefs 后同步更新 clientsStructRefsIds
      // remove client from clientsStructRefsIds to prevent users from applying the same update again
      clientsStructRefsIds = clientsStructRefsIds.filter(c => c !== client)
    }
    // 清空stack
    stack.length = 0
  }

  // iterate over all struct readers until we are done
  while (true) {
    if (stackHead.constructor !== Skip) {
      // 从变量名可以看出这是**本地Doc**的下个clock值
      const localClock = map.setIfUndefined(state, stackHead.id.client, () => getState(store, stackHead.id.client))
      // 计算client id下本地clock和remote clock的差值
      const offset = localClock - stackHead.id.clock

      if (offset < 0) { // offset小于0，说明因为本地和remote相比是有缺失中间操作，所以将这个Item对象丢进stack缓存暂定
        // update from the same client is missing
        stack.push(stackHead)
        // 记录某个client因为某个clock值()未满足而导致本地有缺失(Missing)
        updateMissingSv(stackHead.id.client, stackHead.id.clock - 1)
        // hid a dead wall, add all items from stack to restSS
        addStackToRestSS()
      } else {  // offset大于或者等于0，说明stackHead是本地doc已有的
        // 这是getMissing()的唯一调用之处
        const missing = stackHead.getMissing(transaction, store)
        if (missing !== null) {
          // 说明Item对象依赖的origin/rightOrigin/parent在本地有缺失, 丢进stack暂定
          stack.push(stackHead)
          // get the struct reader that has the missing struct
          /**
           * @type {{ refs: Array<GC|Item>, i: number }}
           */
          const structRefs = clientsStructRefs.get(/** @type {number} */ (missing)) || { refs: [], i: 0 }

          if (structRefs.refs.length === structRefs.i) {
            // structRefs.refs.length === structRefs.i <- 这个条件表示已处理完

            // This update message causally depends on another update message that doesn't exist yet
            // 记录某个client因为某个clock值()未满足而导致本地有缺失(Missing)
            updateMissingSv(/** @type {number} */ (missing), getState(store, missing))
            addStackToRestSS()
          } else {
            stackHead = structRefs.refs[structRefs.i++]
            continue
          }
        } else if (offset === 0 || offset < stackHead.length) {
          // all fine, apply the stackhead

          // offset为0, 或者offset命中stackHead这个Item实例范围内
          // 说明没有中间操作缺失, 也没有依赖缺失, 则调用integrate
          stackHead.integrate(transaction, offset)
          state.set(stackHead.id.client, stackHead.id.clock + stackHead.length)
        }
      }
    }

    // iterate to next stackHead
    if (stack.length > 0) {
      stackHead = /** @type {GC|Item} */ (stack.pop())
    } else if (curStructsTarget !== null && curStructsTarget.i < curStructsTarget.refs.length) {
      stackHead = /** @type {GC|Item} */ (curStructsTarget.refs[curStructsTarget.i++])
    } else {
      curStructsTarget = getNextStructTarget()
      if (curStructsTarget === null) {
        // we are done!
        break
      } else {
        stackHead = /** @type {GC|Item} */ (curStructsTarget.refs[curStructsTarget.i++])
      }
    }
  }

  if (restStructs.clients.size > 0) {
    const encoder = new UpdateEncoderV2()
    writeClientsStructs(encoder, restStructs, new Map())
    // write empty deleteset
    // writeDeleteSet(encoder, new DeleteSet())
    encoding.writeVarUint(encoder.restEncoder, 0) // => no need for an extra function call, just write 0 deletes
    return { missing: missingSV, update: encoder.toUint8Array() }
  }
  return null
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 *
 * @private
 * @function
 */
export const writeStructsFromTransaction = (encoder, transaction) => writeClientsStructs(encoder, transaction.doc.store, transaction.beforeState)

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {UpdateDecoderV1 | UpdateDecoderV2} [structDecoder]
 *
 * @function
 */
export const readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) =>
  // update会通过传入的strcutDecoder逐步decode出来
  transact(ydoc, transaction => {
    // force that transaction.local is set to non-local
    transaction.local = false  // 代表这个transaction是remote发起的
    let retry = false
    const doc = transaction.doc
    const store = doc.store
    // let start = performance.now()

    // 1. 从update里读取所有的structs(Item/Skip/GC实例)
    const ss = readClientsStructRefs(structDecoder, doc)
    // console.log('time to read structs: ', performance.now() - start) // @todo remove
    // start = performance.now()
    // console.log('time to merge: ', performance.now() - start) // @todo remove
    // start = performance.now()

    // 2. 将structs integrate或者说apply给ydoc
    // 也就是将structs里的Item/Skip/GC实例链接到其parent的双向链表中，以及存储在本地ydoc的StructStore里

    // 返回的restStructs或是一个对象(包括missing和update两个字段), 或是null
    // missing: 记录某个client因为某个clock值未满足而导致本地有缺失(Missing)
    // update: 记录ss里未执行integrate的Item/GC对象
    const restStructs = integrateStructs(transaction, store, ss)

    // 3. 将integrateStructs()未处理完的，暂存在本地ydoc StructStore的pendingStructs字段中
    const pending = store.pendingStructs
    if (pending) {
      // check if we can apply something
      for (const [client, clock] of pending.missing) {
        if (clock < getState(store, client)) {
          // 如果pending.missing里某个client id所记录的缺失的clock值，小于StructStore里的clock值, 说明本地StructStore是有pendingStructs继续apply的
          // retry为true就代表有这种情况存在
          retry = true
          break
        }
      }

      if (restStructs) {
        // merge restStructs into store.pending

        // 将restStructs返回的missing情况，merge进pending.missing
        for (const [client, clock] of restStructs.missing) {
          const mclock = pending.missing.get(client)
          if (mclock == null || mclock > clock) {
            pending.missing.set(client, clock)
          }
        }

        // 将restStructs返回的update，merge进pending.update
        pending.update = mergeUpdatesV2([pending.update, restStructs.update])
      }
    } else {
      // 如果store.pendingStructs原本为null, 则将返回的restStructs直接赋给store.pendingStructs
      store.pendingStructs = restStructs
    }

    // console.log('time to integrate: ', performance.now() - start) // @todo remove
    // start = performance.now()

    // 4. 把remote ds apply到本地

    // 返回的dsRest是未处理完的ds
    const dsRest = readAndApplyDeleteSet(structDecoder, transaction, store)

    if (store.pendingDs) {
      // @todo we could make a lower-bound state-vector check as we do above
      const pendingDSUpdate = new UpdateDecoderV2(decoding.createDecoder(store.pendingDs))
      decoding.readVarUint(pendingDSUpdate.restDecoder) // read 0 structs, because we only encode deletes in pendingdsupdate
      const dsRest2 = readAndApplyDeleteSet(pendingDSUpdate, transaction, store)
      if (dsRest && dsRest2) {
        // case 1: ds1 != null && ds2 != null
        store.pendingDs = mergeUpdatesV2([dsRest, dsRest2])
      } else {
        // case 2: ds1 != null
        // case 3: ds2 != null
        // case 4: ds1 == null && ds2 == null
        store.pendingDs = dsRest || dsRest2
      }
    } else {
      // Either dsRest == null && pendingDs == null OR dsRest != null
      store.pendingDs = dsRest
    }
    // console.log('time to cleanup: ', performance.now() - start) // @todo remove
    // start = performance.now()

    // console.log('time to resume delete readers: ', performance.now() - start) // @todo remove
    // start = performance.now()
    if (retry) {
      const update = /** @type {{update: Uint8Array}} */ (store.pendingStructs).update
      store.pendingStructs = null
      applyUpdateV2(transaction.doc, update)
    }
  }, transactionOrigin, false)

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const readUpdate = (decoder, ydoc, transactionOrigin) => readUpdateV2(decoder, ydoc, transactionOrigin, new UpdateDecoderV1(decoder))

/**
 * 这里倒是揭示了update的两种可能的来源
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 *
 * @function
 */
export const applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
  const decoder = decoding.createDecoder(update)
  readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder))
}

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, UpdateDecoderV1)

/**
 * Write all the document as a single update message. If you specify the state of the remote client (`targetStateVector`) it will
 * only write the operations that are missing.
 *
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Doc} doc
 * @param {Map<number,number>} [targetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 *
 * @function
 */
export const writeStateAsUpdate = (encoder, doc, targetStateVector = new Map()) => {
  // 从这个函数就可以看出, yjs中的update包括2部分: StructStore和DeleteSet
  writeClientsStructs(encoder, doc.store, targetStateVector)
  writeDeleteSet(encoder, createDeleteSetFromStructStore(doc.store))
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @param {UpdateEncoderV1 | UpdateEncoderV2} [encoder]
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateAsUpdateV2 = (doc, encodedTargetStateVector = new Uint8Array([0]), encoder = new UpdateEncoderV2()) => {
  const targetStateVector = decodeStateVector(encodedTargetStateVector)
  // 把本地StructStore转成update写入
  writeStateAsUpdate(encoder, doc, targetStateVector)
  // 执行完下面这行代码, updates数组长度为1
  const updates = [encoder.toUint8Array()]
  // also add the pending updates (if there are any)
  if (doc.store.pendingDs) {
    updates.push(doc.store.pendingDs)
  }
  if (doc.store.pendingStructs) {
    updates.push(diffUpdateV2(doc.store.pendingStructs.update, encodedTargetStateVector))
  }

  // updates数组长度大于1, 说明StructStore只是是有pendingDs或pendingStructs之一的
  if (updates.length > 1) {
    if (encoder.constructor === UpdateEncoderV1) {
      return mergeUpdates(updates.map((update, i) => i === 0 ? update : convertUpdateFormatV2ToV1(update)))
    } else if (encoder.constructor === UpdateEncoderV2) {
      return mergeUpdatesV2(updates)
    }
  }

  // encodeStateAsUpdateV2()返回的是一个update数组, 长度为1
  return updates[0]
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @return {Uint8Array}
 * 
 * encodeStateAsUpdate()和encodeStateAsUpdateV2()的区别在于, 第2个参数encoder的类型不同, 一个是UpdateEncoderV1, 一个是UpdateEncoderV2
 *
 * @function
 */
export const encodeStateAsUpdate = (doc, encodedTargetStateVector) => encodeStateAsUpdateV2(doc, encodedTargetStateVector, new UpdateEncoderV1())

/**
 * Read state vector from Decoder and return as Map
 *
 * @param {DSDecoderV1 | DSDecoderV2} decoder
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const readStateVector = decoder => {
  const ss = new Map()
  const ssLength = decoding.readVarUint(decoder.restDecoder)
  for (let i = 0; i < ssLength; i++) {
    const client = decoding.readVarUint(decoder.restDecoder)
    const clock = decoding.readVarUint(decoder.restDecoder)
    ss.set(client, clock)
  }
  return ss
}

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
// export const decodeStateVectorV2 = decodedState => readStateVector(new DSDecoderV2(decoding.createDecoder(decodedState)))

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const decodeStateVector = decodedState => readStateVector(new DSDecoderV1(decoding.createDecoder(decodedState)))

/**
 * @param {DSEncoderV1 | DSEncoderV2} encoder
 * @param {Map<number,number>} sv
 * @function
 */
export const writeStateVector = (encoder, sv) => {
  encoding.writeVarUint(encoder.restEncoder, sv.size)
  array.from(sv.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    encoding.writeVarUint(encoder.restEncoder, client) // @todo use a special client decoder that is based on mapping
    encoding.writeVarUint(encoder.restEncoder, clock)
  })
  return encoder
}

/**
 * @param {DSEncoderV1 | DSEncoderV2} encoder
 * @param {Doc} doc
 *
 * @function
 */
export const writeDocumentStateVector = (encoder, doc) => writeStateVector(encoder, getStateVector(doc.store))

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @param {DSEncoderV1 | DSEncoderV2} [encoder]
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateVectorV2 = (doc, encoder = new DSEncoderV2()) => {
  if (doc instanceof Map) {
    writeStateVector(encoder, doc)
  } else {
    writeDocumentStateVector(encoder, doc)
  }
  return encoder.toUint8Array()
}

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateVector = doc => encodeStateVectorV2(doc, new DSEncoderV1())
