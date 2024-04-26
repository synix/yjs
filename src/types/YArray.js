/**
 * @module YArray
 */

import {
  YEvent,
  AbstractType,
  typeListGet,
  typeListToArray,
  typeListForEach,
  typeListCreateIterator,
  typeListInsertGenerics,
  typeListPushGenerics,
  typeListDelete,
  typeListMap,
  YArrayRefID,
  callTypeObservers,
  transact,
  ArraySearchMarker, UpdateDecoderV1, UpdateDecoderV2, UpdateEncoderV1, UpdateEncoderV2, Doc, Transaction, Item // eslint-disable-line
} from '../internals.js'
import { typeListSlice } from './AbstractType.js'

/**
 * Event that describes the changes on a YArray
 * @template T
 * @extends YEvent<YArray<T>>
 */
export class YArrayEvent extends YEvent {
  /**
   * @param {YArray<T>} yarray The changed type
   * @param {Transaction} transaction The transaction object
   */
  constructor (yarray, transaction) {
    super(yarray, transaction)
    // 这行应该是废弃代码吧...
    this._transaction = transaction
  }
}

/**
 * A shared Array implementation.
 * @template T
 * @extends AbstractType<YArrayEvent<T>>
 * @implements {Iterable<T>}
 */
export class YArray extends AbstractType {
  constructor () {
    super()
    /**
     * @type {Array<any>?}
     * @private
     * prelim是预赛的意思，这里的_prelimContent是指在this.doc为null(未执行过_integrate()方法)的情况下，对YArray进行操作的时候，将操作的内容先缓存在_prelimContent中
     */
    this._prelimContent = []

    /**
     * @type {Array<ArraySearchMarker>}
     * 
     * AbstractType构造方法会把_searchMarker初始化为null, 这里重新初始化为[]
     */
    this._searchMarker = []
  }

  /**
   * Construct a new YArray containing the specified items.
   * @template {Object<string,any>|Array<any>|number|null|string|Uint8Array} T
   * @param {Array<T>} items
   * @return {YArray<T>}
   */
  static from (items) {
    /**
     * @type {YArray<T>}
     */
    const a = new YArray()
    a.push(items)
    return a
  }

  /**
   * Integrate this type into the Yjs instance.
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * os == operation set? (比如insert??)
   * @param {Doc} y The Yjs instance
   * @param {Item} item
   */
  _integrate (y, item) {
    super._integrate(y, item)

    // 把在_prelimContent中预存的内容插入到YArray中
    this.insert(0, /** @type {Array<any>} */ (this._prelimContent))
    this._prelimContent = null
  }

  /**
   * @return {YArray<T>}
   */
  _copy () {
    return new YArray()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YArray<T>}
   */
  clone () {
    /**
     * @type {YArray<T>}
     */
    const arr = new YArray()
    arr.insert(0, this.toArray().map(el =>
      // ytype是要调用clone()方法进行深度拷贝的
      el instanceof AbstractType ? /** @type {typeof el} */ (el.clone()) : el
    ))
    return arr
  }

  get length () {
    // 如果_prelimContent为null，说明已经执行过_integrate()方法，直接返回this._length
    // 否则返回_prelimContent数组的长度
    return this._prelimContent === null ? this._length : this._prelimContent.length
  }

  /**
   * Creates YArrayEvent and calls observers.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, parentSubs) {
    super._callObserver(transaction, parentSubs)
    // YArrayEvent是不使用parentSubs的, 而YMapEvent是使用的
    callTypeObservers(this, transaction, new YArrayEvent(this, transaction))
  }

  // 注意: YArray的index如同_length，是深入到链表项的content层面，而不是链表层面的索引

  /**
   * Inserts new content at an index.
   *
   * Important: This function expects an array of content. Not just a content
   * object. The reason for this "weirdness" is that inserting several elements
   * is very efficient when it is done as a single operation.
   *
   * @example
   *  // Insert character 'a' at position 0
   *  yarray.insert(0, ['a'])
   *  // Insert numbers 1, 2 at position 1
   *  yarray.insert(1, [1, 2])
   *
   * @param {number} index The index to insert content at.
   * @param {Array<T>} content The array of content
   */
  insert (index, content) {
    // 注意: 这里content是数组，待插入到索引index处
    // 如果this.doc不为null，说明已经执行过_integrate()方法，直接调用typeListInsertGenerics()方法
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListInsertGenerics(transaction, this, index, /** @type {any} */ (content))
      })
    } else {
      // 如果this.doc为null，说明还未执行过_integrate()方法，将content暂存到_prelimContent中
      /** @type {Array<any>} */ (this._prelimContent).splice(index, 0, ...content)
    }
  }

  /**
   * Appends content to this YArray.
   *
   * @param {Array<T>} content Array of content to append.
   *
   * @todo Use the following implementation in all types.
   */
  push (content) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListPushGenerics(transaction, this, /** @type {any} */ (content))
      })
    } else {
      /** @type {Array<any>} */ (this._prelimContent).push(...content)
    }
  }

  /**
   * Prepends content to this YArray.
   *
   * @param {Array<T>} content Array of content to prepend.
   */
  unshift (content) {
    this.insert(0, content)
  }

  /**
   * Deletes elements starting from an index.
   *
   * @param {number} index Index at which to start deleting elements
   * @param {number} length The number of elements to remove. Defaults to 1.
   */
  delete (index, length = 1) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListDelete(transaction, this, index, length)
      })
    } else {
      // 这里index在_prelimContent和在链表中的语义是有区别的，因为链表中的index是要对Item深入一层在content层面进行操作的
      /** @type {Array<any>} */ (this._prelimContent).splice(index, length)
    }
  }

  /**
   * Returns the i-th element from a YArray.
   *
   * @param {number} index The index of the element to return from the YArray
   * @return {T}
   */
  get (index) {
    return typeListGet(this, index)
  }

  /**
   * Transforms this YArray to a JavaScript Array.
   *
   * @return {Array<T>}
   */
  toArray () {
    return typeListToArray(this)
  }

  /**
   * Returns a portion of this YArray into a JavaScript Array selected from start to end (end not included)
   *
   * @param {number} [start]
   * @param {number} [end]
   * @return {Array<T>}
   */
  slice (start = 0, end = this.length) {
    return typeListSlice(this, start, end)
  }

  /**
   * Transforms this Shared Type to a JSON object.
   *
   * @return {Array<any>}
   */
  toJSON () {
    return this.map(c => c instanceof AbstractType ? c.toJSON() : c)
  }

  /**
   * Returns an Array with the result of calling a provided function on every
   * element of this YArray.
   *
   * @template M
   * @param {function(T,number,YArray<T>):M} f Function that produces an element of the new Array
   * @return {Array<M>} A new array with each element being the result of the
   *                 callback function
   */
  map (f) {
    return typeListMap(this, /** @type {any} */ (f))
  }

  /**
   * Executes a provided function once on every element of this YArray.
   *
   * @param {function(T,number,YArray<T>):void} f A function to execute on every element of this YArray.
   */
  forEach (f) {
    typeListForEach(this, f)
  }

  /**
   * @return {IterableIterator<T>}
   */
  [Symbol.iterator] () {
    return typeListCreateIterator(this)
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  _write (encoder) {
    encoder.writeTypeRef(YArrayRefID)
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} _decoder
 *
 * @private
 * @function
 */
export const readYArray = _decoder => new YArray()
