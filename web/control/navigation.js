(function (global) {
  'use strict';
  var allowed = false, configurable = false;
  var pages = {
    usage: ['用量总览', '查看当前组织的用量、费用与配额。'],
    audit: ['审计日志', '按时间查看工具调用决策与执行记录。'],
    observability: ['运行与能力', '查看任务运行、模型耗时、沙箱和能力连接状态。'],
    evaluations: ['评测中心', '管理评测集，比较执行结果并完成人工复核。'],
    accounts: ['用户账号', '管理账号、工作区归属与访问权限。'],
    enterpriseSettings: ['组织与连接器', '管理组织结构、单点登录和外部服务连接。'],
    knowledgeAdmin: ['知识索引维护', '查看索引状态并重建异常索引；资料上传与检索请在前台知识库完成。'],
    settings: ['模型与系统配置', '配置服务连接与运行策略，保存草稿后再应用到新任务。']
  };
  function render() {
    var route = location.hash.slice(1).split('?')[0];
    if (!pages[route] || (route === 'settings' && !configurable)) route = 'usage';
    document.querySelectorAll('[data-control-page]').forEach(function (section) {
      section.hidden = !allowed || section.id !== route;
    });
    document.getElementById('panel').hidden = !allowed || !['usage', 'audit'].includes(route);
    document.querySelectorAll('.sidebar .nav-link').forEach(function (link) {
      if (allowed && link.hash === '#' + route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.getElementById('pageTitle').textContent = pages[route][0];
    document.getElementById('currentSection').textContent = pages[route][0];
    document.getElementById('pageDescription').textContent = pages[route][1];
    document.title = pages[route][0] + ' · Tao Agent 管控平台';
  }
  global.TaoControlNavigation = {
    authorize: function (role) { allowed = ['TENANT_ADMIN', 'PLATFORM_ADMIN'].includes(role); render(); },
    configure: function (value) {
      configurable = value === true;
      document.querySelectorAll('[data-platform-only]').forEach(function (link) { link.hidden = !configurable; });
      render();
    },
    deny: function () { allowed = false; render(); },
    refresh: render
  };
  global.addEventListener('hashchange', function () {
    render(); document.getElementById('controlNotice').hidden=true;window.scrollTo(0, 0);
    var title = document.getElementById('pageTitle'); title.tabIndex = -1; title.focus({preventScroll:true});
  });
  render();
})(window);
