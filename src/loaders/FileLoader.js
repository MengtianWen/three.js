import { Cache } from './Cache.js';
import { Loader } from './Loader.js';

const loading = {};

class HttpError extends Error {

	constructor( message, response ) {

		super( message );
		this.response = response;

	}

}
/**
 * 文件加载器，继承自Loader
 */
class FileLoader extends Loader {

	constructor( manager ) {

		super( manager );

	}

	load( url, onLoad, onProgress, onError ) {

		if ( url === undefined ) url = '';

		if ( this.path !== undefined ) url = this.path + url;  //this.path一般为'',所以不会造成多次拼接

		url = this.manager.resolveURL( url );

		const cached = Cache.get( url ); 	// 先从缓存中获取，查看是否已有该url的资源，如果没有则返回undefined

		if ( cached !== undefined ) {	// 没有缓存

			this.manager.itemStart( url );

			setTimeout( () => {

				if ( onLoad ) onLoad( cached );  // 如果有onLoad回调函数，则调用，并传入缓存的资源

				this.manager.itemEnd( url );	

			}, 0 );

			return cached;

		}

		// Check if request is duplicate 检查是否当前url是否正在请求中，避免重复请求

		if ( loading[ url ] !== undefined ) {
			// 如果有重复请求则将回调函数push到数组中，表示多一组待办事项
			loading[ url ].push( {

				onLoad: onLoad,
				onProgress: onProgress,
				onError: onError

			} );

			return;

		}

		// Initialise array for duplicate requests  如果没有重复请求，则构建一个空数组，然后加入代办事项
		loading[ url ] = [];

		loading[ url ].push( {
			onLoad: onLoad,
			onProgress: onProgress,
			onError: onError,
		} );

		// create request 创建请求
		const req = new Request( url, {
			headers: new Headers( this.requestHeader ),
			credentials: this.withCredentials ? 'include' : 'same-origin',
			// An abort controller could be added within a future PR
		} );

		// record states ( avoid data race ) 记录请求状态
		const mimeType = this.mimeType;
		const responseType = this.responseType;

		// start the fetch 开始请求
		fetch( req )
			.then( response => {  // 主要用来处理HTTP状态码和相应的onProgress回调

				if ( response.status === 200 || response.status === 0 ) {  //都表示请求成功

					// Some browsers return HTTP Status 0 when using non-http protocol
					// e.g. 'file://' or 'data://'. Handle as success.

					if ( response.status === 0 ) {

						console.warn( 'THREE.FileLoader: HTTP Status 0 received.' );

					}

					// Workaround: Checking if response.body === undefined for Alipay browser #23548  https://github.com/mrdoob/three.js/issues/23548

					if ( typeof ReadableStream === 'undefined' || response.body === undefined || response.body.getReader === undefined ) {

						return response;

					}

					const callbacks = loading[ url ];
					const reader = response.body.getReader();

					// Nginx needs X-File-Size check
					// https://serverfault.com/questions/482875/why-does-nginx-remove-content-length-header-for-chunked-content
					const contentLength = response.headers.get( 'X-File-Size' ) || response.headers.get( 'Content-Length' );   //获取文件大小
					const total = contentLength ? parseInt( contentLength ) : 0;	//文件大小转换为整数
					const lengthComputable = total !== 0;　//是否支持下载进度，取值为true或者false
					let loaded = 0;

					// periodically read data into the new stream tracking while download progress　周期性读取数据，并追踪下载进度
					const stream = new ReadableStream( {
						start( controller ) {

							readData();

							function readData() {

								reader.read().then( ( { done, value } ) => {

									if ( done ) {

										controller.close();　//如果读取完成，则关闭请求

									} else {

										loaded += value.byteLength;　//更新下载进度

										const event = new ProgressEvent( 'progress', { lengthComputable, loaded, total } );

										// 循环执行所有的onProgress回调，把加载的进度传入
										for ( let i = 0, il = callbacks.length; i < il; i ++ ) {

											const callback = callbacks[ i ];
											if ( callback.onProgress ) callback.onProgress( event );

										}

										controller.enqueue( value ); //将读取到的数据追加到请求中
										readData();

									}

								}, ( e ) => {

									controller.error( e );

								} );

							}

						}

					} );

					return new Response( stream ); //返回一个响应对象

				} else {

					throw new HttpError( `fetch for "${response.url}" responded with ${response.status}: ${response.statusText}`, response );

				}

			} )
			.then( response => {  // 主要用来处理不同responseType的文件  

				switch ( responseType ) {

					case 'arraybuffer':

						return response.arrayBuffer();

					case 'blob':

						return response.blob();

					case 'document':

						return response.text()
							.then( text => {

								const parser = new DOMParser();
								return parser.parseFromString( text, mimeType );

							} );

					case 'json':

						return response.json();

					default:

						if ( mimeType === undefined ) {	// 未定义类型，则默认返回text

							return response.text();

						} else {
							// 如果没有定义mimeType，则从二进制 data 中找到其编码
							// sniff encoding 
							const re = /charset="?([^;"\s]*)"?/i;
							const exec = re.exec( mimeType );
							const label = exec && exec[ 1 ] ? exec[ 1 ].toLowerCase() : undefined;
							const decoder = new TextDecoder( label );
							return response.arrayBuffer().then( ab => decoder.decode( ab ) );

						}

				}

			} )
			.then( data => {	// 主要用来将成功的请求数据加到缓存中，以便后续使用

				// Add to cache only on HTTP success, so that we do not cache
				// error response bodies as proper responses to requests.
				// 只在 HTTP 成功时添加到缓存，以避免将错误响应体视为针对请求的正确响应。
				Cache.add( url, data );

				const callbacks = loading[ url ];
				delete loading[ url ];

				// 循环遍历调用所有的onLoad回调
				for ( let i = 0, il = callbacks.length; i < il; i ++ ) {

					const callback = callbacks[ i ];
					if ( callback.onLoad ) callback.onLoad( data );

				}

			} )
			.catch( err => {   //异常情况的处理

				// Abort errors and other errors are handled the same

				const callbacks = loading[ url ];

				if ( callbacks === undefined ) {   //如果没有onError回调，则直接抛出 Error即可

					// When onLoad was called and url was deleted in `loading`
					this.manager.itemError( url );
					throw err;

				}

				// 删除当前的请求
				delete loading[ url ];

				// 循环遍历调用所有的onError回调
				for ( let i = 0, il = callbacks.length; i < il; i ++ ) {

					const callback = callbacks[ i ];
					if ( callback.onError ) callback.onError( err );

				}

				this.manager.itemError( url );

			} )
			.finally( () => {	// 无论成功与否都会调用，最后将该url的加载停止掉。

				this.manager.itemEnd( url );

			} );

		this.manager.itemStart( url );

	}

	setResponseType( value ) {

		this.responseType = value;
		return this;

	}

	setMimeType( value ) {

		this.mimeType = value;
		return this;

	}

}


export { FileLoader };
