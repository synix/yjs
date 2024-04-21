import {
  GC,
  splitItem,
  Transaction, ID, Item, DSDecoderV2 // eslint-disable-line
} from '../internals.js'

import * as math from 'lib0/math'
import * as error from 'lib0/error'

export class StructStore {
  constructor () {
    /**
     * @type {Map<number,Array<GC|Item>>}
     * 说明StructStore是Item除双向链表之外的另一种存储方式
     * 
     * 双向链表是依据文档序(即document order)建模的
     * StrcutStore是依据逻辑时序(即insertion order)建模的
     * 
     * clients是一个map, key是client id, value是Item和GC(不包括Skip)实例的数组
     * 所以clients map是Struct Store数据结构的核心
     * 
     */
    this.clients = new Map()
    /**
     * @type {null | { missing: Map<number, number>, update: Uint8Array }}
     * 
     * pendingStructs和pendingDs在StructStore类里是没有用到的, 在encoding.js里有用到
     */
    this.pendingStructs = null
    /**
     * @type {null | Uint8Array}
     */
    this.pendingDs = null
  }
}

/**
 * Return the states as a Map<client,clock>.
 * Note that clock refers to the next expected clock id.
 * 
 * 这个方法阐述了YJS的State Vector到底是什么
 * 就是client id到其下一个clock值之间的映射关系
 * 
 * @param {StructStore} store
 * @return {Map<number,number>}
 *
 * @public
 * @function
 */
export const getStateVector = store => {
  // 返回一个Map，key是client id，value是该client的下个clock值
  const sm = new Map()
  store.clients.forEach((structs, client) => {
    const struct = structs[structs.length - 1]
    sm.set(client, struct.id.clock + struct.length)
  })
  return sm
}

/**
 * @param {StructStore} store
 * @param {number} client
 * @return {number}
 *
 * @public
 * @function
*/
// 为什么这个函数叫做getState()，而不是getClock()？
export const getState = (store, client) => {
  const structs = store.clients.get(client)
  if (structs === undefined) {
    return 0
  }

  const lastStruct = structs[structs.length - 1]
  return lastStruct.id.clock + lastStruct.length
}

/**
 * @param {StructStore} store
 *
 * @private
 * @function
 */
export const integretyCheck = store => {
  // 对StructStore进行完整性检查: 即其内部的所有Item/GC实例的clock值是连续的
  store.clients.forEach(structs => {
    for (let i = 1; i < structs.length; i++) {
      const l = structs[i - 1]
      const r = structs[i]
      if (l.id.clock + l.length !== r.id.clock) {
        throw new Error('StructStore failed integrety check')
      }
    }
  })
}

/**
 * @param {StructStore} store
 * @param {GC|Item} struct
 *
 * @private
 * @function
 */
export const addStruct = (store, struct) => {
  let structs = store.clients.get(struct.id.client)
  if (structs === undefined) {
    structs = []
    store.clients.set(struct.id.client, structs)
  } else {
    const lastStruct = structs[structs.length - 1]
    if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
      throw error.unexpectedCase()
    }
  }
  structs.push(struct)
}

/**
 * Perform a binary search on a sorted array
 * 在structs数组里二分查找clock所命中的Item实例的索引
 * 
 * @param {Array<Item|GC>} structs
 * @param {number} clock
 * @return {number}
 *
 * @private
 * @function
 */
export const findIndexSS = (structs, clock) => {
  let left = 0
  let right = structs.length - 1
  let mid = structs[right]
  let midclock = mid.id.clock
  if (midclock === clock) {
    return right
  }
  // @todo does it even make sense to pivot the search?
  // If a good split misses, it might actually increase the time to find the correct item.
  // Currently, the only advantage is that search with pivoting might find the item on the first try.

  // 计算传入的clock值占structs数组最大clock值的比例，然后找出同比例下的索引值作为midindex
  let midindex = math.floor((clock / (midclock + mid.length - 1)) * right) // pivoting the search

  while (left <= right) {
    mid = structs[midindex]
    midclock = mid.id.clock
    if (midclock <= clock) {
      if (clock < midclock + mid.length) {
        return midindex
      }
      left = midindex + 1
    } else {
      right = midindex - 1
    }
    midindex = math.floor((left + right) / 2)
  }
  // Always check state before looking for a struct in StructStore
  // Therefore the case of not finding a struct is unexpected
  throw error.unexpectedCase()
}

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {GC|Item}
 *
 * @private
 * @function
 */
export const find = (store, id) => {
  /**
   * @type {Array<GC|Item>}
   */
  // @ts-ignore
  const structs = store.clients.get(id.client)
  return structs[findIndexSS(structs, id.clock)]
}

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 * @private
 * @function
 */
export const getItem = /** @type {function(StructStore,ID):Item} */ (find)

/**
 * @param {Transaction} transaction
 * @param {Array<Item|GC>} structs
 * @param {number} clock
 */
export const findIndexCleanStart = (transaction, structs, clock) => {
  // 这个方法和findIndexSS()的区别在于:
  // findIndexSS()查找的是clock所命中的Item实例的索引，clock值是落在Item实例的范围内的, 即item.id.clock <= clock < item.id.clock + item.length
  // findIndexCleanStart()查找的是clock所精确匹配的Item实例的索引，即item.id.clock === clock，会强行通过splitItem()将Item实例拆分成两个Item实例来满足这个条件
  const index = findIndexSS(structs, clock)
  const struct = structs[index]
  if (struct.id.clock < clock && struct instanceof Item) {
    structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock))
    return index + 1
  }
  return index
}

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {Transaction} transaction
 * @param {ID} id
 * @return {Item}
 *
 * @private
 * @function
 */
export const getItemCleanStart = (transaction, id) => {
  const structs = /** @type {Array<Item>} */ (transaction.doc.store.clients.get(id.client))
  return structs[findIndexCleanStart(transaction, structs, id.clock)]
}

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 * 
 * // getItemCleanEnd()和getItemCleanStart()是对应的
 * // getItemCleanEnd()查找的也是id.clock所精确匹配的Item实例的索引，但满足的条件是id.clock = item.id.clock + item.length - 1
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {ID} id
 * @return {Item}
 *
 * @private
 * @function
 */
export const getItemCleanEnd = (transaction, store, id) => {
  /**
   * @type {Array<Item>}
   */
  // @ts-ignore
  const structs = store.clients.get(id.client)
  const index = findIndexSS(structs, id.clock)
  const struct = structs[index]
  if (id.clock !== struct.id.clock + struct.length - 1 && struct.constructor !== GC) {
    structs.splice(index + 1, 0, splitItem(transaction, struct, id.clock - struct.id.clock + 1))
  }
  return struct
}

/**
 * Replace `item` with `newitem` in store
 * @param {StructStore} store
 * @param {GC|Item} struct
 * @param {GC|Item} newStruct
 *
 * @private
 * @function
 */
export const replaceStruct = (store, struct, newStruct) => {
  const structs = /** @type {Array<GC|Item>} */ (store.clients.get(struct.id.client))
  structs[findIndexSS(structs, struct.id.clock)] = newStruct
}

/**
 * Iterate over a range of structs
 *
 * @param {Transaction} transaction
 * @param {Array<Item|GC>} structs
 * @param {number} clockStart Inclusive start
 * @param {number} len
 * @param {function(GC|Item):void} f
 *
 * @function
 */
export const iterateStructs = (transaction, structs, clockStart, len, f) => {
  if (len === 0) {
    return
  }
  const clockEnd = clockStart + len
  let index = findIndexCleanStart(transaction, structs, clockStart)
  let struct
  do {
    struct = structs[index++]
    if (clockEnd < struct.id.clock + struct.length) {
      // 如果clockEnd只是命中了struct，也就是小于struct.id.clock + struct.length，那么就需要将struct拆分成两个struct
      findIndexCleanStart(transaction, structs, clockEnd)
    }
    f(struct)
  } while (index < structs.length && structs[index].id.clock < clockEnd)
}
