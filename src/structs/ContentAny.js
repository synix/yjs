import {
  UpdateEncoderV1, UpdateEncoderV2, UpdateDecoderV1, UpdateDecoderV2, Transaction, Item, StructStore // eslint-disable-line
} from '../internals.js'

export class ContentAny {
  /**
   * @param {Array<any>} arr
   */
  constructor (arr) {
    /**
     * @type {Array<any>}
     * 存储JavaScript基本数据类型的值的数组
     */
    this.arr = arr
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.arr.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.arr
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentAny}
   */
  copy () {
    return new ContentAny(this.arr)
  }

  /**
   * @param {number} offset
   * @return {ContentAny}
   */
  splice (offset) {
    // 把当前ContentAny从offset处分拆成两个ContentAny
    const right = new ContentAny(this.arr.slice(offset))
    this.arr = this.arr.slice(0, offset)
    return right
  }

  /**
   * @param {ContentAny} right
   * @return {boolean}
   */
  mergeWith (right) {
    // 拼接两个ContentAny为一个ContentAny
    this.arr = this.arr.concat(right.arr)
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {}
  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    // 这个write()方法和下面的readContentAny()函数是对应的，对应ContentAny的序列化和反序列化
    const len = this.arr.length
    encoder.writeLen(len - offset)
    for (let i = offset; i < len; i++) {
      const c = this.arr[i]
      encoder.writeAny(c)
    }
  }

  /**
   * @return {number}
   */
  getRef () {
    // 为什么是8？这是在哪里定义的?
    return 8
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentAny}
 */
export const readContentAny = decoder => {
  const len = decoder.readLen()
  const cs = []
  for (let i = 0; i < len; i++) {
    cs.push(decoder.readAny())
  }
  return new ContentAny(cs)
}
