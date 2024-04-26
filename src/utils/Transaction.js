import {
  getState,
  writeStructsFromTransaction,
  writeDeleteSet,
  DeleteSet,
  sortAndMergeDeleteSet,
  getStateVector,
  findIndexSS,
  callEventHandlerListeners,
  Item,
  generateNewClientId,
  createID,
  cleanupYTextAfterTransaction,
  UpdateEncoderV1, UpdateEncoderV2, GC, StructStore, AbstractType, AbstractStruct, YEvent, Doc // eslint-disable-line
} from '../internals.js'

import * as map from 'lib0/map'
import * as math from 'lib0/math'
import * as set from 'lib0/set'
import * as logging from 'lib0/logging'
import { callAll } from 'lib0/function'

/**
 * A transaction is created for every change on the Yjs model. It is possible
 * to bundle changes on the Yjs model in a single transaction to
 * minimize the number on messages sent and the number of observer calls.
 * If possible the user of this library should bundle as many changes as
 * possible. Here is an example to illustrate the advantages of bundling:
 *
 * 上面的messages说的是ydoc上的update/updateV2消息, observer calls说的是ytype上的observe()/observeDeep()注册的listener
 * 
 * 
 * @example
 * const ydoc = new Y.Doc()
 * const map = ydoc.getMap('map')
 * // Log content when change is triggered
 * map.observe(() => {
 *   console.log('change triggered')
 * })
 * // Each change on the map type triggers a log message:
 * map.set('a', 0) // => "change triggered"
 * map.set('b', 0) // => "change triggered"
 * // When put in a transaction, it will trigger the log after the transaction:
 * ydoc.transact(() => {
 *   map.set('a', 1)
 *   map.set('b', 1)
 * }) // => "change triggered"
 *
 * @public
 */
export class Transaction {
  /**
   * @param {Doc} doc
   * @param {any} origin
   * @param {boolean} local
   */
  constructor (doc, origin, local) {
    /**
     * The Yjs instance.
     * @type {Doc}
     */
    this.doc = doc
    /**
     * Describes the set of deleted items by ids
     * @type {DeleteSet}
     */
    this.deleteSet = new DeleteSet()
    /**
     * Holds the state before the transaction started.
     * @type {Map<Number,Number>}
     */
    this.beforeState = getStateVector(doc.store)
    /**
     * Holds the state after the transaction.
     * 
     * afterState和beforeState的diff，就是ydoc的StructStore里新增的structs
     * 
     * @type {Map<Number,Number>}
     */
    this.afterState = new Map()
    /**
     * All types that were directly modified (property added or child
     * inserted/deleted). New types are not included in this Set.
     * Maps from type to parentSubs (`item.parentSub = null` for YArray)
     * 
     * 
     * 这个map的key是ytype(其实是某个ytype的parent, 一般也就是YArray或者YMap对象), value是parentSub集合
     * 除YMap之外, 其他ytype对象的parentSub都是null
     * 只有YMap对象, parentSub是YMap对象的key集合, 代表ymap中的哪些key发生了变化
     * 
     * 仅有addChangedTypeToTransaction()函数会给这个map添加元素
     * 
     * changed用来辅助实现observe()的功能
     * 
     * @type {Map<AbstractType<YEvent<any>>,Set<String|null>>}
     */
    this.changed = new Map()
    /**
     * Stores the events for the types that observe also child elements.
     * It is mainly used by `observeDeep`.
     * @type {Map<AbstractType<YEvent<any>>,Array<YEvent<any>>>}
     * 
     * map的key是一个ytype实例, value是一个YEvent实例数组, 数组里存放的是ytype对象触发的事件
     * 也就是某个ytype对象发生变化时，触及到的其所有父type都会作为key存入这个map中, 触发的事件会push进value数组
     * 
     * changedParentTypes用来辅助实现observeDeep()的功能
     * 
     */
    this.changedParentTypes = new Map()

    /**
     * @type {Array<AbstractStruct>}
     * 
     * 这个_mergeStructs起什么作用??
     */
    this._mergeStructs = []

    /**
     * @type {any}
     */
    this.origin = origin

    /**
     * Stores meta information on the transaction
     * @type {Map<any,any>}
     */
    this.meta = new Map()

    /**
     * Whether this change originates from this doc.
     * @type {boolean}
     * 
     * 代表这个transaction是remote发起的还是local发起的
     * 
     */
    this.local = local
    /**
     * @type {Set<Doc>}
     */
    this.subdocsAdded = new Set()
    /**
     * @type {Set<Doc>}
     */
    this.subdocsRemoved = new Set()
    /**
     * @type {Set<Doc>}
     */
    this.subdocsLoaded = new Set()
    /**
     * @type {boolean}
     * 
     * 专门用来标记是否需要对YText里的format进行cleanup
     * 
     * YText._callObserver()被调用时, YText对象满足下述条件时, 会将_needFormattingCleanup设置为true
     * !transaction.local && this._hasFormatting
     */
    this._needFormattingCleanup = false
  }
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 * @return {boolean} Whether data was written.
 * 
 * 从这个函数的实现可以看出, ydoc的update消息的消息体包括2部分
 * 1. 通过writeStructsFromTransaction()写入ydoc的StructStore里的所有新增的structs, 是client id到clock值的映射
 * 2. 通过writeDeleteSet()写入transation所收集的DeleteSet, 是client id到DeleteItem数组的映射
 */
export const writeUpdateMessageFromTransaction = (encoder, transaction) => {
  // 如果transaction的deleteSet为空, 并且transaction的afterState和beforeState相同(也就是ydoc的StructStore也没变化), 则不需要发送update消息
  if (transaction.deleteSet.clients.size === 0 && !map.any(transaction.afterState, (clock, client) => transaction.beforeState.get(client) !== clock)) {
    return false
  }
  sortAndMergeDeleteSet(transaction.deleteSet)
  writeStructsFromTransaction(encoder, transaction)
  writeDeleteSet(encoder, transaction.deleteSet)
  return true
}

/**
 * @param {Transaction} transaction
 *
 * @private
 * @function
 */
export const nextID = transaction => {
  const y = transaction.doc
  return createID(y.clientID, getState(y.store, y.clientID))
}

/**
 * If `type.parent` was added in current transaction, `type` technically
 * did not change, it was just added and we should not fire events for `type`.
 *
 * 仅有Item的integrate()和delete()方法会调用这个函数
 * 
 * @param {Transaction} transaction
 * @param {AbstractType<YEvent<any>>} type
 * @param {string|null} parentSub
 */
export const addChangedTypeToTransaction = (transaction, type, parentSub) => {
  const item = type._item

  // 如果item为null,
  // 或者item的clock值小于transaction执行前的值, 并且item未被删除(如果item的clock值大于transaction执行前的值, 则item是新增的, 就不能认为item发生change了)
  // 则把type添加到transaction.changed里
  if (item === null || (item.id.clock < (transaction.beforeState.get(item.id.client) || 0) && !item.deleted)) {
    map.setIfUndefined(transaction.changed, type, set.create).add(parentSub)
  }
}

/**
 * @param {Array<AbstractStruct>} structs
 * @param {number} pos
 * @return {number} # of merged structs
 */
const tryToMergeWithLefts = (structs, pos) => {
  let right = structs[pos]
  let left = structs[pos - 1]
  let i = pos

  for (; i > 0; right = left, left = structs[--i - 1]) {
    if (left.deleted === right.deleted && left.constructor === right.constructor) {
      if (left.mergeWith(right)) {
        if (right instanceof Item && right.parentSub !== null && /** @type {AbstractType<any>} */ (right.parent)._map.get(right.parentSub) === right) {
          /** @type {AbstractType<any>} */ (right.parent)._map.set(right.parentSub, /** @type {Item} */ (left))
        }
        continue
      }
    }
    break
  }

  const merged = pos - i
  if (merged) {
    // remove all merged structs from the array
    structs.splice(pos + 1 - merged, merged)
  }

  return merged
}

/**
 * @param {DeleteSet} ds
 * @param {StructStore} store
 * @param {function(Item):boolean} gcFilter
 * 
 * 这里就是实现了Item对象的墓碑机制
 * 
 */
const tryGcDeleteSet = (ds, store, gcFilter) => {
  for (const [client, deleteItems] of ds.clients.entries()) {
    const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))

    for (let di = deleteItems.length - 1; di >= 0; di--) {
      const deleteItem = deleteItems[di]
      const endDeleteItemClock = deleteItem.clock + deleteItem.len

      for (
        let si = findIndexSS(structs, deleteItem.clock), struct = structs[si];
        si < structs.length && struct.id.clock < endDeleteItemClock;
        struct = structs[++si]
      ) {
        const struct = structs[si]
        // struct已经超出了deleteItem的范围, 就不用再往后遍历了
        if (deleteItem.clock + deleteItem.len <= struct.id.clock) {
          break
        }
        
        if (struct instanceof Item && struct.deleted && !struct.keep && gcFilter(struct)) {
          struct.gc(store, false)
        }
      }
    }
  }
}

/**
 * @param {DeleteSet} ds
 * @param {StructStore} store
 */
const tryMergeDeleteSet = (ds, store) => {
  // try to merge deleted / gc'd items
  // merge from right to left for better efficiency and so we don't miss any merge targets
  ds.clients.forEach((deleteItems, client) => {
    const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
    for (let di = deleteItems.length - 1; di >= 0; di--) {
      const deleteItem = deleteItems[di]
      // start with merging the item next to the last deleted item
      const mostRightIndexToCheck = math.min(structs.length - 1, 1 + findIndexSS(structs, deleteItem.clock + deleteItem.len - 1))
      for (
        let si = mostRightIndexToCheck, struct = structs[si];
        si > 0 && struct.id.clock >= deleteItem.clock;
        struct = structs[si]
      ) {
        // tryToMergeWithLefts()函数返回的是合并的struct个数
        si -= 1 + tryToMergeWithLefts(structs, si)
      }
    }
  })
}

/**
 * @param {DeleteSet} ds
 * @param {StructStore} store
 * @param {function(Item):boolean} gcFilter
 */
export const tryGc = (ds, store, gcFilter) => {
  tryGcDeleteSet(ds, store, gcFilter)
  tryMergeDeleteSet(ds, store)
}

/**
 * @param {Array<Transaction>} transactionCleanups
 * @param {number} i
 * 
 * cleanupTransactions()函数会在transact()函数中调用, 并递归调用自身
 */
const cleanupTransactions = (transactionCleanups, i) => {
  if (i < transactionCleanups.length) {
    const transaction = transactionCleanups[i]
    const doc = transaction.doc
    const store = doc.store
    const ds = transaction.deleteSet

    const mergeStructs = transaction._mergeStructs

    try {
      // 把ds里每个client id的deleteItems按照clock值从小到大排序, 并把相邻的deleteItems进行合并
      sortAndMergeDeleteSet(ds)

      // beforeState在创建Transation时初始化的
      // 所以通过beforeState和afterState就能计算出一份diff
      transaction.afterState = getStateVector(transaction.doc.store)


      /***** 开始处理ytype上通过observe()/observeDeep()注册的listener *****/

      // 通知一下, 要给doc里发生变化的ytype实例发通知了😄
      doc.emit('beforeObserverCalls', [transaction, doc])

      /**
       * An array of event callbacks.
       *
       * Each callback is called even if the other ones throw errors.
       *
       * @type {Array<function():void>}
       */
      const fs = []

      // observe events on changed types
      transaction.changed.forEach((subs, itemtype) =>
        fs.push(() => {
          if (itemtype._item === null || !itemtype._item.deleted) {
            // 这里是源码里唯一调用ytype._callObserver()方法之处
            itemtype._callObserver(transaction, subs)
          }
        })
      )

      fs.push(() => {
        // deep observe events
        transaction.changedParentTypes.forEach((events, type) => {
          // We need to think about the possibility that the user transforms the
          // Y.Doc in the event.

          if (type._dEH.l.length > 0 && (type._item === null || !type._item.deleted)) {
            events = events
              .filter(event =>
                event.target._item === null || !event.target._item.deleted
              )

            events
              .forEach(event => {
                event.currentTarget = type
                // path is relative to the current target
                event._path = null
              })

            // sort events by path length so that top-level events are fired first.
            events
              .sort((event1, event2) => event1.path.length - event2.path.length)

            // We don't need to check for events.length
            // because we know it has at least one element
            callEventHandlerListeners(type._dEH, events, transaction)
          }
        })
      })

      fs.push(() => doc.emit('afterTransaction', [transaction, doc]))

      callAll(fs, [])

      /***** 结束处理ytype上通过observe()/observeDeep()注册的listener *****/

      if (transaction._needFormattingCleanup) {
        cleanupYTextAfterTransaction(transaction)
      }
    } finally {
      /***** 开始实施墓碑机制 *****/

      // Replace deleted items with ItemDeleted / GC.
      // This is where content is actually remove from the Yjs Doc.
      if (doc.gc) {
        tryGcDeleteSet(ds, store, doc.gcFilter)
      }
      
      tryMergeDeleteSet(ds, store)

      /***** 结束实施墓碑机制 *****/
      
      // 尽量merge StructStore里新增的structs
      // on all affected store.clients props, try to merge
      transaction.afterState.forEach((clock, client) => {
        const beforeClock = transaction.beforeState.get(client) || 0
        if (beforeClock !== clock) { // 说明在这个transaction里, 这个client id的clock值发生了变化
          const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
          // we iterate from right to left so we can safely remove entries
          const firstChangePos = math.max(findIndexSS(structs, beforeClock), 1)
          for (let i = structs.length - 1; i >= firstChangePos;) {
            i -= 1 + tryToMergeWithLefts(structs, i)
          }
        }
      })

      // try to merge mergeStructs
      // @todo: it makes more sense to transform mergeStructs to a DS, sort it, and merge from right to left
      //        but at the moment DS does not handle duplicates
      for (let i = mergeStructs.length - 1; i >= 0; i--) {
        const { client, clock } = mergeStructs[i].id
        const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
        const replacedStructPos = findIndexSS(structs, clock)
        if (replacedStructPos + 1 < structs.length) {
          if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
            continue // no need to perform next check, both are already merged
          }
        }
        if (replacedStructPos > 0) {
          tryToMergeWithLefts(structs, replacedStructPos)
        }
      }

      if (!transaction.local && transaction.afterState.get(doc.clientID) !== transaction.beforeState.get(doc.clientID)) {
        logging.print(logging.ORANGE, logging.BOLD, '[yjs] ', logging.UNBOLD, logging.RED, 'Changed the client-id because another client seems to be using it.')
        doc.clientID = generateNewClientId()
      }

      // @todo Merge all the transactions into one and provide send the data as a single update message
      doc.emit('afterTransactionCleanup', [transaction, doc])

      /***** 开始ydoc发送update消息 *****/
      if (doc._observers.has('update')) {
        const encoder = new UpdateEncoderV1()
        const hasContent = writeUpdateMessageFromTransaction(encoder, transaction)
        if (hasContent) {
          doc.emit('update', [encoder.toUint8Array(), transaction.origin, doc, transaction])
        }
      }

      if (doc._observers.has('updateV2')) {
        const encoder = new UpdateEncoderV2()
        const hasContent = writeUpdateMessageFromTransaction(encoder, transaction)
        if (hasContent) {
          doc.emit('updateV2', [encoder.toUint8Array(), transaction.origin, doc, transaction])
        }
      }

      /***** 结束ydoc发送update消息 *****/

      const { subdocsAdded, subdocsLoaded, subdocsRemoved } = transaction

      if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
        subdocsAdded.forEach(subdoc => {
          subdoc.clientID = doc.clientID
          if (subdoc.collectionid == null) {
            subdoc.collectionid = doc.collectionid
          }
          doc.subdocs.add(subdoc)
        })
        subdocsRemoved.forEach(subdoc => doc.subdocs.delete(subdoc))
        doc.emit('subdocs', [{ loaded: subdocsLoaded, added: subdocsAdded, removed: subdocsRemoved }, doc, transaction])
        subdocsRemoved.forEach(subdoc => subdoc.destroy())
      }

      // i + 1超过了transactionCleanups数组的长度, 说明transactionCleanups已经被清空了
      if (transactionCleanups.length <= i + 1) {
        doc._transactionCleanups = []
        doc.emit('afterAllTransactions', [doc, transactionCleanups])
      } else {
        // 继续处理下一个transaction
        cleanupTransactions(transactionCleanups, i + 1)
      }
    }
  }
}

/**
 * Implements the functionality of `y.transact(()=>{..})`
 *
 * @template T
 * @param {Doc} doc
 * @param {function(Transaction):T} f
 * @param {any} [origin=true]
 * @return {T}
 *
 * @function
 */
export const transact = (doc, f, origin = null, local = true) => {
  // 注意transact()是一个函数, 而不是Transaction类的方法
  const transactionCleanups = doc._transactionCleanups

  // 表示是否复用了doc._transaction，如果未能复用则创建Transaction对象并赋给doc._transaction, initialCall为true
  let initialCall = false
  /**
   * @type {any}
   */
  let result = null

  // 这里是实现了Transaction对象的复用机制, 如果doc._transaction不为null, 则直接复用这个已有的Transaction对象
  if (doc._transaction === null) {
    initialCall = true
    doc._transaction = new Transaction(doc, origin, local)

    transactionCleanups.push(doc._transaction)
    if (transactionCleanups.length === 1) {
      // beforeAllTransactions事件对应的是afterAllTransactions事件

      // beforeAllTransactions事件表示transactionCleanups开始非空了
      // afterAllTransactions事件表示transactionCleanups被清空了
      doc.emit('beforeAllTransactions', [doc])
    }

    // beforeTransaction对应afterTransaction事件, aferTransaction事件会在cleanupTransactions()函数中触发
    doc.emit('beforeTransaction', [doc._transaction, doc])
  }

  try {
    result = f(doc._transaction)
  } finally {
    // 表示在调用transact()时创建了Transaction对象
    if (initialCall) {
      // 如果当前Transaction对象是doc._transactionCleanups数组里的第1个, 则finishCleanup为true
      const finishCleanup = doc._transaction === transactionCleanups[0]
      doc._transaction = null

      if (finishCleanup) {
        // The first transaction ended, now process observer calls.
        // Observer call may create new transactions for which we need to call the observers and do cleanup.
        // We don't want to nest these calls, so we execute these calls one after
        // another.
        // Also we need to ensure that all cleanups are called, even if the
        // observes throw errors.
        // This file is full of hacky try {} finally {} blocks to ensure that an
        // event can throw errors and also that the cleanup is called.
        cleanupTransactions(transactionCleanups, 0)
      }
    }
  }
  return result
}
