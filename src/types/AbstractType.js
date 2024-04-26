import {
  removeEventHandlerListener,
  callEventHandlerListeners,
  addEventHandlerListener,
  createEventHandler,
  getState,
  isVisible,
  ContentType,
  createID,
  ContentAny,
  ContentBinary,
  getItemCleanStart,
  ContentDoc, YText, YArray, UpdateEncoderV1, UpdateEncoderV2, Doc, Snapshot, Transaction, EventHandler, YEvent, Item, // eslint-disable-line
} from '../internals.js'

import * as map from 'lib0/map'
import * as iterator from 'lib0/iterator'
import * as error from 'lib0/error'
import * as math from 'lib0/math'

const maxSearchMarker = 80

/**
 * A unique timestamp that identifies each marker.
 *
 * Time is relative,.. this is more like an ever-increasing clock.
 *
 * @type {number}
 */
let globalSearchMarkerTimestamp = 0

export class ArraySearchMarker {
  /**
   * @param {Item} p
   * @param {number} index
   */
  constructor (p, index) {
    p.marker = true
    this.p = p
    this.index = index
    this.timestamp = globalSearchMarkerTimestamp++
  }
}

/**
 * @param {ArraySearchMarker} marker
 */
const refreshMarkerTimestamp = marker => { marker.timestamp = globalSearchMarkerTimestamp++ }

/**
 * This is rather complex so this function is the only thing that should overwrite a marker
 *
 * @param {ArraySearchMarker} marker
 * @param {Item} p
 * @param {number} index
 */
const overwriteMarker = (marker, p, index) => {
  // 原来marker里Item不再被marker了
  marker.p.marker = false
  marker.p = p
  p.marker = true
  marker.index = index
  marker.timestamp = globalSearchMarkerTimestamp++
}

/**
 * @param {Array<ArraySearchMarker>} searchMarker
 * @param {Item} p
 * @param {number} index
 */
const markPosition = (searchMarker, p, index) => {
  if (searchMarker.length >= maxSearchMarker) {
    // override oldest marker (we don't want to create more objects)
    // 返回timestamp值最小的marker
    const marker = searchMarker.reduce((a, b) => a.timestamp < b.timestamp ? a : b)
    overwriteMarker(marker, p, index)
    return marker
  } else {
    // create new marker
    const pm = new ArraySearchMarker(p, index)
    searchMarker.push(pm)
    return pm
  }
}

// 下面这行说明了marker到底是做什么用的吧

/**
 * Search marker help us to find positions in the associative array faster.
 *
 * They speed up the process of finding a position without much bookkeeping.
 *
 * A maximum of `maxSearchMarker` objects are created.
 *
 * This function always returns a refreshed marker (updated timestamp)
 *
 * @param {AbstractType<any>} yarray
 * @param {number} index
 */
export const findMarker = (yarray, index) => {
  if (yarray._start === null || index === 0 || yarray._searchMarker === null) {
    return null
  }

  // 找到一个和传入的index值最接近的marker
  const marker = yarray._searchMarker.length === 0 ? null : yarray._searchMarker.reduce((a, b) => math.abs(index - a.index) < math.abs(index - b.index) ? a : b)

  // 缺省情况下, 从链表头_start开始遍历
  let p = yarray._start
  // 缺省情况下，从链表头开始，也就是从数组的index 0开始
  let pindex = 0

  // 缺省情况下, 从链表头_start开始遍历，如果找到一个marker，就从这个marker开始遍历
  if (marker !== null) {
    // 改为从marker指向的item的遍历
    p = marker.p
    // 改为从marker指向的item的index开始
    pindex = marker.index
    // 刷新这个marker的timestamp
    refreshMarkerTimestamp(marker) // we used it, we might need to use it again
  }

  // 先从左向右遍历，尝试去找index对应的item
  // iterate to right if possible
  while (p.right !== null && pindex < index) {
    if (!p.deleted && p.countable) {
      if (index < pindex + p.length) {
        break
      }
      pindex += p.length
    }
    p = p.right
  }

  // iterate to left if necessary (might be that pindex > index)
  // 再从右向左遍历，尝试去找index对应的item
  while (p.left !== null && pindex > index) {
    p = p.left
    if (!p.deleted && p.countable) {
      pindex -= p.length
    }
  }

  // 经过上述两个white循环，index就位于p指向的item中, pindex是这个item的起始index

  // we want to make sure that p can't be merged with left, because that would screw up everything
  // in that case just return what we have (it is most likely the best marker anyway)
  // iterate to left until p can't be merged with left

  // while循环里的条件为真，就表示p这个item能和它左边的item合并
  while (p.left !== null && p.left.id.client === p.id.client && p.left.id.clock + p.left.length === p.id.clock) {
    p = p.left
    if (!p.deleted && p.countable) {
      pindex -= p.length
    }
  }

  // @todo remove!
  // assure position
  // {
  //   let start = yarray._start
  //   let pos = 0
  //   while (start !== p) {
  //     if (!start.deleted && start.countable) {
  //       pos += start.length
  //     }
  //     start = /** @type {Item} */ (start.right)
  //   }
  //   if (pos !== pindex) {
  //     debugger
  //     throw new Error('Gotcha position fail!')
  //   }
  // }
  // if (marker) {
  //   if (window.lengthes == null) {
  //     window.lengthes = []
  //     window.getLengthes = () => window.lengthes.sort((a, b) => a - b)
  //   }
  //   window.lengthes.push(marker.index - pindex)
  //   console.log('distance', marker.index - pindex, 'len', p && p.parent.length)
  // }

  // 如果最终找到的精确的index和已存在的最近的marker相差甚微，就复用这个marker，否则就创建一个新的marker
  if (marker !== null && math.abs(marker.index - pindex) < /** @type {YText|YArray<any>} */ (p.parent).length / maxSearchMarker) {
    // adjust existing marker
    overwriteMarker(marker, p, pindex)
    return marker
  } else {
    // create new marker
    return markPosition(yarray._searchMarker, p, pindex)
  }
}

/**
 * Update markers when a change happened.
 *
 * This should be called before doing a deletion!
 *
 * @param {Array<ArraySearchMarker>} searchMarker
 * @param {number} index
 * @param {number} len If insertion, len is positive. If deletion, len is negative.
 */
export const updateMarkerChanges = (searchMarker, index, len) => {
  // 从后往前遍历searchMarker数组
  for (let i = searchMarker.length - 1; i >= 0; i--) {
    const m = searchMarker[i]

    if (len > 0) {
      /**
       * @type {Item|null}
       */
      let p = m.p
      p.marker = false
      // Ideally we just want to do a simple position comparison, but this will only work if
      // search markers don't point to deleted items for formats.
      // Iterate marker to prev undeleted countable position so we know what to do when updating a position
      while (p && (p.deleted || !p.countable)) {
        p = p.left
        if (p && !p.deleted && p.countable) {
          // adjust position. the loop should break now
          m.index -= p.length
        }
      }

      if (p === null || p.marker === true) {
        // remove search marker if updated position is null or if position is already marked
        searchMarker.splice(i, 1)
        continue
      }
      m.p = p
      p.marker = true
    }

    if (index < m.index || (len > 0 && index === m.index)) { // a simple index <= m.index check would actually suffice
      m.index = math.max(index, m.index + len)
    }
  }
}

/**
 * Accumulate all (list) children of a type and return them as an Array.
 *
 * @param {AbstractType<any>} t
 * @return {Array<Item>}
 */
export const getTypeChildren = t => {
  let s = t._start
  const arr = []
  while (s) {
    arr.push(s)
    s = s.right
  }
  return arr
}

/**
 * Call event listeners with an event. This will also add an event to all
 * parents (for `.observeDeep` handlers).
 *
 * @template EventType
 * @param {AbstractType<EventType>} type
 * @param {Transaction} transaction
 * @param {EventType} event
 */
export const callTypeObservers = (type, transaction, event) => {
  const changedType = type
  const changedParentTypes = transaction.changedParentTypes
  while (true) {
    // 给此type的所有父type添加event

    // @ts-ignore
    map.setIfUndefined(changedParentTypes, type, () => []).push(event)
    // 触及到顶层ytype对象，也就是放在Y.Doc实例的share Map里的ytype对象了
    if (type._item === null) {
      break
    }
    // 沿着parent向上遍历
    type = /** @type {AbstractType<any>} */ (type._item.parent)
  }

  // 触发所有ytype._eH中注册的handler
  callEventHandlerListeners(changedType._eH, event, transaction)
}

/**
 * @template EventType
 * Abstract Yjs Type class
 * 
 * YText/YArray/YMap/YXmlFragment的父类
 * 虽然命名为AbstractType，但是它并不是一个抽象类，而是可以实例化的
 * 
 * 细数一下yjs中核心类之间的关系:
 * 
 * YType(也就是AbstractType及其子类):
 *  _item: 维系和Item对象的一对一关系
 *  _map: 如果ytype(譬如YMap对象)内部结构是一个map, _map就是这个map
 *  _start: 如果ytype(譬如YArray对象)内部结构是一个双向链表，_start就是链表的头指针
 *  _length: 不是链表的元素个数，而是深入一层到Item的content里，把截取到的所有Item的content的length相加起来
 * 
 *  👆_map和_start/_length是二选一
 * 
 * Item:
 *  parent: 父ytype, 比如YArray或者YMap
 *  parentSub: 当parent为YMap时, parentSub是parent的某个key
 *  left/right: 构成双向链表的左右指针
 *  content: Item实例实际存放的内容, 维系和ytype的一对一关系
 * 
 */
export class AbstractType {
  constructor () {
    /**
     * @type {Item|null}
     * 
     * 维护和Item实例一对一的映射关系
     * 
     * The item and type object pair have a 1-1 mapping. 
     * The item's content field references the AbstractType object and the AbstractType object's _item field references the item.
     * 
     * 如果ytype直接放在Y.Doc实例的share Map里, 那么这个ytype的_item就是null
     * 
     */
    this._item = null

    /**
     * @type {Map<string,Item>}
     * 这个_map是给YMap和YText使用的
     * 对于YMap而言, _map的value存的是key对应的value的当前值, value的历史值是作为墓碑和当前值一起链接成一个双向链表的, 这个双向链表的尾指针就是_map的value
     */
    this._map = new Map()

    /**
     * @type {Item|null}
     * 
     * 每个ytype都是双向链表呈现给用户的视图(view), _start是头指针
     * 双向链表的每个元素都是一个Item对象，Item对象包含了当前Item的内容(content字段)，以及指向前一个Item的left指针，指向后一个Item的right指针
     */
    this._start = null

    /**
     * @type {Doc|null}
     * 
     * _integrate()被调用时doc会被赋值, 表示这个ytype被integrate到了这个ydoc实例里
     */
    this.doc = null

    // 这个_length代表的并不是链表的元素个数，而是深入一层到Item的content里，把所有Item的content的length相加起来
    this._length = 0

    /**
     * Event handlers
     * @type {EventHandler<EventType,Transaction>}
     * 
     * eH是Event Handler的缩写
     * 调用observe()方法注册的handler，都会被添加到_eH的l数组里
     */
    this._eH = createEventHandler()

    /**
     * Deep event handlers
     * @type {EventHandler<Array<YEvent<any>>,Transaction>}
     * 
     * dEH是Deep Event Handler的缩写
     * 调用observeDeep()方法注册的handler，都会被添加到_dEH的l数组里
     */
    this._dEH = createEventHandler()

    /**
     * @type {null | Array<ArraySearchMarker>}
     * 因为双向链表按index查找元素的性能是比较差的
     * 所以这里将查找结果缓存起来，也就是把index和Item的映射关系存储在_searchMarker数组里
     * search marker是作者最初在代码实现时采用的名字, 其实叫做skiplist更专业一些
     * 
     * 这个_searchMarker数组的元素是ArraySearchMarker对象，它包含了一个Item对象和一个index值
     */
    this._searchMarker = null
  }

  /**
   * @return {AbstractType<any>|null}
   */
  get parent () {
    return this._item ? /** @type {AbstractType<any>} */ (this._item.parent) : null
  }

  /**
   * Integrate this type into the Yjs instance.
   * 
   * y代表YDoc实例，_item代表这个ytype对应的Item实例, 这个Item实例的parent指向这个ytype的父ytype
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * @param {Doc} y The Yjs instance
   * @param {Item|null} item
   */
  _integrate (y, item) {
    this.doc = y
    this._item = item
  }

  /**
   * @return {AbstractType<EventType>}
   */
  _copy () {
    throw error.methodUnimplemented()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {AbstractType<EventType>}
   */
  clone () {
    throw error.methodUnimplemented()
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
   */
  _write (_encoder) { }

  /**
   * The first non-deleted item
   */
  get _first () {
    let n = this._start
    while (n !== null && n.deleted) {
      n = n.right
    }
    return n
  }

  /**
   * Creates YEvent and calls all type observers.
   * Must be implemented by each type.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} _parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, _parentSubs) {
    // 如果transaction.local为false, 即这个transaction是由remote发起的，那么就清空_searchMarker数组。为什么??
    if (!transaction.local && this._searchMarker) {
      this._searchMarker.length = 0
    }
  }

  /**
   * Observe all events that are created on this type.
   *
   * @param {function(EventType, Transaction):void} f Observer function
   */
  observe (f) {
    addEventHandlerListener(this._eH, f)
  }

  /**
   * Observe all events that are created by this type and its children.
   *
   * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
   */
  observeDeep (f) {
    addEventHandlerListener(this._dEH, f)
  }

  /**
   * Unregister an observer function.
   *
   * @param {function(EventType,Transaction):void} f Observer function
   */
  unobserve (f) {
    removeEventHandlerListener(this._eH, f)
  }

  /**
   * Unregister an observer function.
   *
   * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
   */
  unobserveDeep (f) {
    removeEventHandlerListener(this._dEH, f)
  }

  /**
   * @abstract
   * @return {any}
   */
  toJSON () {}
}

/**
 * @param {AbstractType<any>} type
 * @param {number} start
 * @param {number} end
 * @return {Array<any>}
 *
 * @private
 * @function
 */
export const typeListSlice = (type, start, end) => {
  if (start < 0) {
    start = type._length + start
  }
  if (end < 0) {
    end = type._length + end
  }
  let len = end - start
  const cs = []
  let n = type._start
  while (n !== null && len > 0) {
    if (n.countable && !n.deleted) {
      const c = n.content.getContent()
      if (c.length <= start) {
        start -= c.length
      } else {
        for (let i = start; i < c.length && len > 0; i++) {
          cs.push(c[i])
          len--
        }
        // 从此以后start就是0了, 因为已经截取到了传入的start位置的Item对象，接下来的Item对象都是从0开始截取了
        start = 0
      }
    }
    n = n.right
  }
  return cs
}

/**
 * @param {AbstractType<any>} type
 * @return {Array<any>}
 *
 * @private
 * @function
 */
export const typeListToArray = type => {
  // 返回的cs数组并不是YType里Item链表直接转换出来的，而是会深入一层对每个Item的content进行拆解，然后放到cs数组里
  // cs == content set??
  const cs = []
  let n = type._start
  while (n !== null) {
    if (n.countable && !n.deleted) {
      const c = n.content.getContent()
      for (let i = 0; i < c.length; i++) {
        cs.push(c[i])
      }
    }
    n = n.right
  }
  return cs
}

/**
 * @param {AbstractType<any>} type
 * @param {Snapshot} snapshot
 * @return {Array<any>}
 *
 * @private
 * @function
 */
export const typeListToArraySnapshot = (type, snapshot) => {
  const cs = []
  let n = type._start
  while (n !== null) {
    if (n.countable && isVisible(n, snapshot)) {
      const c = n.content.getContent()
      for (let i = 0; i < c.length; i++) {
        cs.push(c[i])
      }
    }
    n = n.right
  }
  return cs
}

/**
 * Executes a provided function on once on every element of this YArray.
 *
 * @param {AbstractType<any>} type
 * @param {function(any,number,any):void} f A function to execute on every element of this YArray.
 *
 * @private
 * @function
 */
export const typeListForEach = (type, f) => {
  let index = 0
  let n = type._start
  while (n !== null) {
    if (n.countable && !n.deleted) {
      const c = n.content.getContent()
      for (let i = 0; i < c.length; i++) {
        f(c[i], index++, type)
      }
    }
    n = n.right
  }
}

/**
 * @template C,R
 * @param {AbstractType<any>} type
 * @param {function(C,number,AbstractType<any>):R} f
 * @return {Array<R>}
 *
 * @private
 * @function
 */
export const typeListMap = (type, f) => {
  /**
   * @type {Array<any>}
   */
  const result = []
  typeListForEach(type, (c, i) => {
    result.push(f(c, i, type))
  })
  return result
}

/**
 * @param {AbstractType<any>} type
 * @return {IterableIterator<any>}
 *
 * @private
 * @function
 */
export const typeListCreateIterator = type => {
  let n = type._start
  /**
   * @type {Array<any>|null}
   */
  let currentContent = null
  let currentContentIndex = 0
  return {
    [Symbol.iterator] () {
      // 这个就是return后面这个对象
      return this
    },
    next: () => {
      // find some content
      if (currentContent === null) {
        // 上一个Item对象的content已经被消费完了...找下一个Item对象赋给currentContent继续消费
        while (n !== null && n.deleted) {
          n = n.right
        }
        // check if we reached the end, no need to check currentContent, because it does not exist
        if (n === null) {
          return {
            done: true,
            value: undefined
          }
        }
        // we found n, so we can set currentContent
        currentContent = n.content.getContent()
        // 开始消费新的Item对象, 所以currentContentIndex重置为0
        currentContentIndex = 0
        n = n.right // we used the content of n, now iterate to next
      }

      const value = currentContent[currentContentIndex++]
      // check if we need to empty currentContent
      if (currentContent.length <= currentContentIndex) {
        currentContent = null
      }
      return {
        done: false,
        value
      }
    }
  }
}

/**
 * Executes a provided function on once on every element of this YArray.
 * Operates on a snapshotted state of the document.
 *
 * @param {AbstractType<any>} type
 * @param {function(any,number,AbstractType<any>):void} f A function to execute on every element of this YArray.
 * @param {Snapshot} snapshot
 *
 * @private
 * @function
 */
export const typeListForEachSnapshot = (type, f, snapshot) => {
  let index = 0
  let n = type._start
  while (n !== null) {
    if (n.countable && isVisible(n, snapshot)) {
      const c = n.content.getContent()
      for (let i = 0; i < c.length; i++) {
        f(c[i], index++, type)
      }
    }
    n = n.right
  }
}

/**
 * @param {AbstractType<any>} type
 * @param {number} index
 * @return {any}
 *
 * @private
 * @function
 */
export const typeListGet = (type, index) => {
  const marker = findMarker(type, index)
  let n = type._start
  if (marker !== null) {
    n = marker.p
    index -= marker.index
  }
  for (; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) {
        return n.content.getContent()[index]
      }
      index -= n.length
    }
  }
}

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {Item?} referenceItem
 * @param {Array<Object<string,any>|Array<any>|boolean|number|null|string|Uint8Array>} content
 *
 * @private
 * @function
 */
export const typeListInsertGenericsAfter = (transaction, parent, referenceItem, content) => {
  // 注意: 
  // 第3个参数referenceItem是一个Item对象，它是插入位置的前一个Item，如果referenceItem为null，就表示插入到parent容器的头部
  // 第4个参数content是一个数组，包含待插入的所有数据

  // left在这个函数里要经过多次赋值，因为content是一个数组，left代表待插入元素的left指针
  // 随着content数组元素不断插入，left指针会不断向右移动，所以会有多次赋值
  let left = referenceItem
  const doc = transaction.doc
  const ownClientId = doc.clientID
  const store = doc.store
  // 如果referenceItem为null，表示插入到为parent容器的头部，即parent容器的链表头将会易主，待插入Item的right指针指向当前链表头
  // 否则，插入为referenceItem的下一个元素(referenceItem的right指针指向的) ，即right将为referenceItem的right

  // right在这个函数里只经过这一次赋值, 所以待插入的元素永远在referenceItem之前
  const right = referenceItem === null ? parent._start : referenceItem.right

  /**
   * @type {Array<Object|Array<any>|number|null>}
   */
  let jsonContent = []

  const packJsonContent = () => {
    // 把jsonContent数组里已经收集到的JavaScript基本数据类型的值，打包成一个ContentAny对象
    if (jsonContent.length > 0) {
      // JavaScript基本数据类型对应ContentAny
      left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentAny(jsonContent))
      left.integrate(transaction, 0)
      jsonContent = []
    }
  }

  // 从这个forEach遍历可以看出, content数组里除了连续的JavaScript基本数据类型的值，其他类型的值都会对应一个Item实例
  // 而content数组里的JavaScript基本数据类型的值，如果是连续的，会被收集到jsonContent数组里，然后打包成一个Item(见上述packJsonContent()函数)
  content.forEach(c => {
    if (c === null) {
      jsonContent.push(c)
    } else {
      switch (c.constructor) {
        case Number:
        case Object:
        case Boolean:
        case Array:
        case String:
          // 如果是JavaScript里的基本数据类型，就直接push到jsonContent数组里
          jsonContent.push(c)
          break
        default:
          packJsonContent()

          switch (c.constructor) {
            case Uint8Array:
            case ArrayBuffer:
              // 因为parent为ymap, 所以这个函数里parentSub传入的都是null

              // Uint8Array/ArrayBuffer对应ContentBinary
              left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentBinary(new Uint8Array(/** @type {Uint8Array} */ (c))))
              left.integrate(transaction, 0)
              break
            case Doc:
              // Y.Doc对应ContentDoc
              left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentDoc(/** @type {Doc} */ (c)))
              left.integrate(transaction, 0)
              break
            default:
              if (c instanceof AbstractType) {
                // 说明c是一个YText/YArray/YMap/YXmlFragment实例，这些类型对应ContentType
                left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentType(c))
                left.integrate(transaction, 0)
              } else {
                throw new Error('Unexpected content type in insert operation')
              }
          }
      }
    }
  })

  packJsonContent()
}

const lengthExceeded = () => error.create('Length exceeded!')

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {number} index
 * @param {Array<Object<string,any>|Array<any>|number|null|string|Uint8Array>} content
 *
 * @private
 * @function
 */
export const typeListInsertGenerics = (transaction, parent, index, content) => {
  // 如果插入位置超过了超过了parent的_length，就抛出异常
  if (index > parent._length) {
    throw lengthExceeded()
  }

  // 如果插入位置是0，就直接插入到parent容器的头部
  if (index === 0) {
    // 0索引处新增了content.length个元素, 得更新一下parent._searchMarker
    if (parent._searchMarker) {
      updateMarkerChanges(parent._searchMarker, index, content.length)
    }
    // 第3个referenceItem参数为null，代表插入到parent容器头部
    return typeListInsertGenericsAfter(transaction, parent, null, content)
  }

  const startIndex = index
  const marker = findMarker(parent, index)

  /***** 下面这些代码在锁定插入位置，也就是相对n所指向Item对象的index索引处(index可能横跨多个Item实例) *****/

  let n = parent._start
  if (marker !== null) {
    n = marker.p
    index -= marker.index
    // we need to iterate one to the left so that the algorithm works
    if (index === 0) {
      // @todo refactor this as it actually doesn't consider formats
      n = n.prev // important! get the left undeleted item so that we can actually decrease index
      // 这里index是0，所以用+=和=并无区别
      index += (n && n.countable && !n.deleted) ? n.length : 0
    }
  }

  /***** 下面这些代码执行完，插入位置就紧随n所指向Item对象之后  *****/

  for (; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index <= n.length) {
        if (index < n.length) {
          // insert in-between
          getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index))
        }
        break
      }
      index -= n.length
    }
  }

  if (parent._searchMarker) {
    updateMarkerChanges(parent._searchMarker, startIndex, content.length)
  }

  return typeListInsertGenericsAfter(transaction, parent, n, content)
}

/**
 * Pushing content is special as we generally want to push after the last item. So we don't have to update
 * the serach marker.
 *
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {Array<Object<string,any>|Array<any>|number|null|string|Uint8Array>} content
 *
 * @private
 * @function
 */
export const typeListPushGenerics = (transaction, parent, content) => {
  // Use the marker with the highest index and iterate to the right.
  // 找出index值最大的marker
  const marker = (parent._searchMarker || []).reduce((maxMarker, currMarker) => currMarker.index > maxMarker.index ? currMarker : maxMarker, { index: 0, p: parent._start })
  // 要么从链表头开始，要么从marker指向的item开始，找到链表尾
  let n = marker.p
  if (n) {
    while (n.right) {
      n = n.right
    }
  }

  // 第3个参数传入的是null，表示插入到链表尾
  return typeListInsertGenericsAfter(transaction, parent, n, content)
}

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {number} index
 * @param {number} length
 *
 * @private
 * @function
 */
export const typeListDelete = (transaction, parent, index, length) => {
  if (length === 0) { return }
  const startIndex = index
  const startLength = length
  const marker = findMarker(parent, index)
  let n = parent._start
  if (marker !== null) {
    n = marker.p
    index -= marker.index
  }
  // compute the first item to be deleted
  for (; n !== null && index > 0; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) {
        getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index))
      }
      index -= n.length
    }
  }

  // 上个循环结束后，n指向的是第一个要删除的item

  // delete all items until done
  while (length > 0 && n !== null) {
    if (!n.deleted) {
      if (length < n.length) {
        getItemCleanStart(transaction, createID(n.id.client, n.id.clock + length))
      }
      n.delete(transaction)
      length -= n.length
    }
    n = n.right
  }

  if (length > 0) {
    throw lengthExceeded()
  }

  if (parent._searchMarker) {
    // startLength是传入的length的原始值
    // 如果length递减为0, 那第3个参数就是-startLength
    // 如果length递减为负值, 那第3个参数就是-startLength + length
    updateMarkerChanges(parent._searchMarker, startIndex, -startLength + length /* in case we remove the above exception */)
  }
}

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {string} key
 *
 * @private
 * @function
 */
export const typeMapDelete = (transaction, parent, key) => {
  const c = parent._map.get(key)
  if (c !== undefined) {
    c.delete(transaction)
  }
}

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @param {Object|number|null|Array<any>|string|Uint8Array|AbstractType<any>} value
 *
 * @private
 * @function
 */
export const typeMapSet = (transaction, parent, key, value) => {
  const left = parent._map.get(key) || null
  const doc = transaction.doc
  const ownClientId = doc.clientID
  let content
  if (value == null) {
    content = new ContentAny([value])
  } else {
    switch (value.constructor) {
      case Number:
      case Object:
      case Boolean:
      case Array:
      case String:
        content = new ContentAny([value])
        break
      case Uint8Array:
        content = new ContentBinary(/** @type {Uint8Array} */ (value))
        break
      case Doc:
        content = new ContentDoc(/** @type {Doc} */ (value))
        break
      default:
        if (value instanceof AbstractType) {
          content = new ContentType(value)
        } else {
          throw new Error('Unexpected content type')
        }
    }
  }

  // origin类型为ID, 但是并不指向实际存在的Item对象, 初始化时是left所指向的Item对象的最后一个clock值
  // right和rightOrigin都为null, 表示ymap的value是一个双向链表，value的当前值位于表尾
  // parentSub传入的是ymap某个key的值
  new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, null, null, parent, key, content).integrate(transaction, 0)
}

/**
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @return {Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined}
 *
 * @private
 * @function
 */
export const typeMapGet = (parent, key) => {
  const val = parent._map.get(key)
  return val !== undefined && !val.deleted ? val.content.getContent()[val.length - 1] : undefined
}

/**
 * @param {AbstractType<any>} parent
 * @return {Object<string,Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined>}
 *
 * @private
 * @function
 */
export const typeMapGetAll = (parent) => {
  /**
   * @type {Object<string,any>}
   */
  const res = {}
  parent._map.forEach((value, key) => {
    if (!value.deleted) {
      res[key] = value.content.getContent()[value.length - 1]
    }
  })
  return res
}

/**
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @return {boolean}
 *
 * @private
 * @function
 */
export const typeMapHas = (parent, key) => {
  const val = parent._map.get(key)
  return val !== undefined && !val.deleted
}

/**
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @param {Snapshot} snapshot
 * @return {Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined}
 *
 * @private
 * @function
 */
export const typeMapGetSnapshot = (parent, key, snapshot) => {
  let v = parent._map.get(key) || null
  while (v !== null && (!snapshot.sv.has(v.id.client) || v.id.clock >= (snapshot.sv.get(v.id.client) || 0))) {
    v = v.left
  }
  return v !== null && isVisible(v, snapshot) ? v.content.getContent()[v.length - 1] : undefined
}

/**
 * @param {AbstractType<any>} parent
 * @param {Snapshot} snapshot
 * @return {Object<string,Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined>}
 *
 * @private
 * @function
 */
export const typeMapGetAllSnapshot = (parent, snapshot) => {
  /**
   * @type {Object<string,any>}
   */
  const res = {}
  parent._map.forEach((value, key) => {
    /**
     * @type {Item|null}
     */
    let v = value
    while (v !== null && (!snapshot.sv.has(v.id.client) || v.id.clock >= (snapshot.sv.get(v.id.client) || 0))) {
      v = v.left
    }
    if (v !== null && isVisible(v, snapshot)) {
      res[key] = v.content.getContent()[v.length - 1]
    }
  })
  return res
}

/**
 * @param {Map<string,Item>} map
 * @return {IterableIterator<Array<any>>}
 *
 * @private
 * @function
 */
export const createMapIterator = map => iterator.iteratorFilter(map.entries(), /** @param {any} entry */ entry => !entry[1].deleted)
