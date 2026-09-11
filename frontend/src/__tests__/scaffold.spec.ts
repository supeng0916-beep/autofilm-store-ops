// 脚手架集成冒烟测试：验证 Vitest + happy-dom + @vue/test-utils 工具链，
// 以及 Element Plus / Pinia / Vue Router 均已真实可用（而非仅安装依赖）。
// 注意：此处 router/store 均为测试内局部实例；真实布局、路由、页面、http 客户端属 Task 6。
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, defineStore } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ElementPlus, { ElButton } from 'element-plus';

const useCounterStore = defineStore('scaffold-counter', {
  state: () => ({ n: 21 }),
  getters: { doubled: (state) => state.n * 2 },
});

describe('frontend scaffold integration', () => {
  it('vitest + happy-dom + @vue/test-utils work', () => {
    const Comp = defineComponent({ render: () => h('span', 'ok') });
    const wrapper = mount(Comp);
    expect(wrapper.text()).toBe('ok');
  });

  it('Element Plus is usable', () => {
    const wrapper = mount(ElButton, {
      global: { plugins: [ElementPlus] },
      slots: { default: () => 'submit' },
    });
    expect(wrapper.find('button').exists()).toBe(true);
    expect(wrapper.classes()).toContain('el-button');
    expect(wrapper.text()).toContain('submit');
  });

  it('Pinia is usable', () => {
    const Comp = defineComponent({
      setup() {
        const store = useCounterStore();
        return () => h('span', String(store.doubled));
      },
    });
    const wrapper = mount(Comp, { global: { plugins: [createPinia()] } });
    expect(wrapper.text()).toBe('42');
  });

  it('Vue Router is usable', async () => {
    const Home = defineComponent({ render: () => h('div', 'home-page') });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: Home }],
    });
    const App = defineComponent({ render: () => h(RouterView) });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.isReady();
    expect(wrapper.text()).toContain('home-page');
  });
});
