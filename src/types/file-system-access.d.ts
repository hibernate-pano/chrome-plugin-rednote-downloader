/**
 * File System Access API 的类型补充。
 *
 * TypeScript 的 DOM lib 里还没有这几个方法（浏览器早就支持了），
 * 这里用声明合并补上 —— 只声明我们真正用到的那部分。
 */

interface FileSystemHandlePermissionDescriptor {
  /** 'read' 只读；'readwrite' 需要能创建和写入文件 */
  mode?: 'read' | 'readwrite';
}

interface FileSystemDirectoryHandle {
  /** 查当前授权状态：granted / denied / prompt */
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  /** 申请授权 —— 必须在用户手势里调用 */
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  /** 记住上次选的目录（同一个 id 共享这份记忆） */
  id?: string;
  mode?: 'read' | 'readwrite';
  /** 对话框打开时停在哪 */
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | FileSystemHandle;
}

interface Window {
  /** 弹出目录选择框 —— 必须在用户手势里调用 */
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
