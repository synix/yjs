import {
  readYArray,
  readYMap,
  readYText,
  readYXmlElement,
  readYXmlFragment,
  readYXmlHook,
  readYXmlText,
  UpdateDecoderV1, UpdateDecoderV2, UpdateEncoderV1, UpdateEncoderV2, StructStore, Transaction, Item, YEvent, AbstractType // eslint-disable-line
} from '../internals.js'

import * as error from 'lib0/error'

/**
 * @type {Array<function(UpdateDecoderV1 | UpdateDecoderV2):AbstractType<any>>}
 * @private
 */
export const typeRefs = [
  readYArray,
  readYMap,
  readYText,
  readYXmlElement,
  readYXmlFragment,
  readYXmlHook,
  readYXmlText
]

export const YArrayRefID = 0
export const YMapRefID = 1
export const YTextRefID = 2
export const YXmlElementRefID = 3
export const YXmlFragmentRefID = 4
export const YXmlHookRefID = 5
export const YXmlTextRefID = 6

/**
 * @private
 */
export class ContentType {
  /**
   * @param {AbstractType<any>} type
   */
  constructor (type) {
    /**
     * @type {AbstractType<any>}
     */
    // 具体存的YType实例
    this.type = type
  }

  /**
   * @return {number}
   */
  getLength () {
    // ContentType存放的是一个YType实例，所以length为1
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    // 即使只有1个实例，也要以数组返回，是为了getContent()这个方法的统一性
    return [this.type]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentType}
   */
  copy () {
    return new ContentType(this.type._copy())
  }

  /**
   * @param {number} offset
   * @return {ContentType}
   */
  splice (offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {ContentType} right
   * @return {boolean}
   */
  mergeWith (right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    this.type._integrate(transaction.doc, item)
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    /***** 回收ytype内部的双向链表  *****/
    let item = this.type._start

    while (item !== null) {
      if (!item.deleted) {
        item.delete(transaction)
      } else if (item.id.clock < (transaction.beforeState.get(item.id.client) || 0)) {
        // This will be gc'd later and we want to merge it if possible
        // We try to merge all deleted items after each transaction,
        // but we have no knowledge about that this needs to be merged
        // since it is not in transaction.ds. Hence we add it to transaction._mergeStructs
        transaction._mergeStructs.push(item)
      }
      item = item.right
    }

    /***** 回收ytype内部的_map  *****/
    this.type._map.forEach(item => {
      if (!item.deleted) {
        item.delete(transaction)
      } else if (item.id.clock < (transaction.beforeState.get(item.id.client) || 0)) {
        // same as above
        transaction._mergeStructs.push(item)
      }
    })

    // this.type已经被删除了, 就没有必要再触发其observe()注册的listener了
    transaction.changed.delete(this.type)
  }

  /**
   * @param {StructStore} store
   */
  gc (store) {
    let item = this.type._start
    while (item !== null) {
      item.gc(store, true)
      item = item.right
    }
    this.type._start = null

    this.type._map.forEach(/** @param {Item | null} item */ (item) => {
      while (item !== null) {
        item.gc(store, true)
        item = item.left
      }
    })
    this.type._map = new Map()
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    this.type._write(encoder)
  }

  /**
   * @return {number}
   */
  getRef () {
    return 7
  }
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentType}
 */

// decoder.readTypeRef() -> 读出具体YType的类型标识，比如YArrayRefID
// typeRefs[decoder.readTypeRef()] -> 查找到具体的readYType()函数，比如readYArray()
// 传入decoder，给readYType()函数，返回一个新建的YType实例
// 通过ContentType构造一个ContentType对象，存放这个新建的ytype
export const readContentType = decoder => new ContentType(typeRefs[decoder.readTypeRef()](decoder))
