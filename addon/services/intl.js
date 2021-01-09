/**
 * Copyright 2015, Yahoo! Inc.
 * Copyrights licensed under the New BSD License. See the accompanying LICENSE file for terms.
 */
import { getOwner } from '@ember/application';
import { computed, get, set } from '@ember/object';
import Evented from '@ember/object/evented';
import { assert } from '@ember/debug';
import { makeArray } from '@ember/array';
import Service from '@ember/service';
import { next, cancel } from '@ember/runloop';

import { FormatDate, FormatMessage, FormatNumber, FormatRelative, FormatTime } from '../-private/formatters';
import isArrayEqual from '../-private/utils/is-array-equal';
import normalizeLocale from '../-private/utils/normalize-locale';
import getDOM from '../-private/utils/get-dom';
import hydrate from '../-private/utils/hydrate';
import memoize from 'fast-memoize';
import { createIntl, createIntlCache, IntlErrorCode } from '@formatjs/intl';
import flatten, { NestedStructure } from 'ember-intl/-private/utils/flatten';

export default Service.extend(Evented, {
  /** @public **/
  formats: null,

  /**
   * Returns an array of registered locale names
   *
   * @property locales
   * @public
   */
  locales: computed('_messagesMap', function () {
    return Object.keys(get(this, '_messagesMap'));
  }),

  /** @public **/
  locale: computed('_locale', {
    set(_, localeName) {
      const proposed = makeArray(localeName).map(normalizeLocale);

      if (!isArrayEqual(proposed, this._locale)) {
        set(this, '_locale', proposed);
        cancel(this._timer);
        this._timer = next(() => {
          this.trigger('localeChanged');
          this._updateDocumentLanguage(this._locale);
        });
      }

      return this._locale;
    },
    get() {
      return get(this, '_locale');
    },
  }),

  /**
   * Returns the first locale of the currently active locales
   *
   * @property primaryLocale
   * @public
   */
  primaryLocale: computed.readOnly('locale.0'),

  /** @public **/
  formatRelative: createFormatterProxy('relative'),

  /** @public **/
  formatMessage: createFormatterProxy('message'),

  /** @public **/
  formatNumber: createFormatterProxy('number'),

  /** @public **/
  formatTime: createFormatterProxy('time'),

  /** @public **/
  formatDate: createFormatterProxy('date'),

  /**
   * @type {Record<string, Record<string, string>>}
   * @private
   */
  _messagesMap: {},

  /** @private **/
  _locale: null,

  /** @private **/
  _timer: null,

  /** @private **/
  _formatters: null,

  _intls: null,

  _cache: createIntlCache(),

  /** @public **/
  init() {
    this._super(...arguments);

    const initialLocale = get(this, 'locale') || ['en-us'];

    this.setLocale(initialLocale);
    this._owner = getOwner(this);
    this._formatters = this._createFormatters();

    if (!this.formats) {
      this.formats = this._owner.resolveRegistration('formats:main') || {};
    }

    this.onIntlError = this.onIntlError.bind(this);
    this.getIntl = this.getIntl.bind(this);
    this.createIntl = memoize((locale, formats) => {
      return createIntl(
        {
          locale,
          defaultLocale: locale,
          formats,
          defaultFormats: formats,
          onError: this.onIntlError,
          messages: this._messagesMap[locale],
        },
        this._cache
      );
    });

    hydrate(this);
  },

  willDestroy() {
    this._super(...arguments);
    cancel(this._timer);
  },

  onIntlError(err) {
    if (err.code !== IntlErrorCode.MISSING_TRANSLATION) {
      throw err;
    }
  },

  /** @private **/
  onError({ /* kind, */ error }) {
    throw error;
  },

  /** @public **/
  lookup(key, localeName) {
    const localeNames = this._localeWithDefault(localeName);

    for (let i = 0; i < localeNames.length; i++) {
      const messages = this._messagesMap[localeNames[i]] || {};
      const translation = messages[key];

      if (translation !== undefined) {
        return translation;
      }
    }
  },

  /**
   * @private
   */
  getIntl(locale) {
    return this.createIntl(Array.isArray(locale) ? locale[0] : locale, this.formats);
  },

  validateKeys(keys) {
    return keys.forEach((key) => {
      assert(
        `[ember-intl] expected translation key "${key}" to be of type String but received: "${typeof key}"`,
        typeof key === 'string'
      );
    });
  },

  /** @public **/
  t(key, options = {}) {
    return this.formatMessage({ id: key }, options);
  },

  /** @public **/
  exists(key, localeName) {
    const localeNames = this._localeWithDefault(localeName);

    assert(`[ember-intl] locale is unset, cannot lookup '${key}'`, Array.isArray(localeNames) && localeNames.length);

    return localeNames.some((localeName) => (this._messagesMap[localeName] || {})[key]);
  },

  /** @public */
  setLocale(locale) {
    assert(
      `[ember-intl] no locale has been set!  See: https://ember-intl.github.io/ember-intl/docs/quickstart#4-configure-ember-intl`,
      locale
    );

    set(this, 'locale', locale);
  },

  /**
   * @public
   * @param {string} localeName
   * @param {Record<string, string>} payload
   */
  addTranslations(localeName, payload) {
    this._messagesMap[normalizeLocale(localeName)] = flatten(payload);
  },

  /**
   * @public
   * @param {string} localeName
   * @returns {Record<string, string>}
   */
  translationsFor(localeName) {
    return this._messagesMap[normalizeLocale(localeName)];
  },

  /** @private **/
  _localeWithDefault(localeName) {
    if (!localeName) {
      return get(this, '_locale') || [];
    }

    if (typeof localeName === 'string') {
      return makeArray(localeName).map(normalizeLocale);
    }

    if (Array.isArray(localeName)) {
      return localeName.map(normalizeLocale);
    }
  },

  /** @private **/
  _updateDocumentLanguage(locales) {
    const dom = getDOM(this);

    if (dom) {
      const [primaryLocale] = locales;
      const html = dom.documentElement;
      html.setAttribute('lang', primaryLocale);
    }
  },

  /** @private */
  _createFormatters() {
    const formatterConfig = {
      getIntl: (locale) => this.getIntl(locale),
    };

    return {
      message: new FormatMessage(formatterConfig),
      relative: new FormatRelative(formatterConfig),
      number: new FormatNumber(formatterConfig),
      time: new FormatTime(formatterConfig),
      date: new FormatDate(formatterConfig),
    };
  },
});

function createFormatterProxy(name) {
  return function serviceFormatterProxy(value, formatOptions) {
    let locale;

    if (formatOptions && formatOptions.locale) {
      locale = this._localeWithDefault(formatOptions.locale);
    } else {
      locale = get(this, 'locale');
    }

    return this._formatters[name].format(locale, value, formatOptions);
  };
}
