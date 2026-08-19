// 持久静态插件：宿主半区（空实现）
// 作用：让本包出现在 Host Loader 里；浏览器半区经 exports["./client"] + dsh.client 声明加载。
// 本插件为纯客户端展示层（对话密度地图），不依赖任何宿主服务。
function apply() {}

export { apply };
