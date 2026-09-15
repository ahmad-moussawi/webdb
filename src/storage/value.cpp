#include "storage/value.hpp"

#include <limits>

namespace webdb {

bool Value::is_valid_utf8(std::string_view sv) noexcept {
    const auto* s = reinterpret_cast<const uint8_t*>(sv.data());
    const size_t len = sv.size();
    size_t i = 0;

    while (i < len) {
        if (s[i] <= 0x7F) {
            i += 1;
        } else if ((s[i] & 0xE0) == 0xC0) {
            if (i + 1 >= len || (s[i + 1] & 0xC0) != 0x80) return false;
            if (s[i] < 0xC2) return false;  // Overlong encoding
            i += 2;
        } else if ((s[i] & 0xF0) == 0xE0) {
            if (i + 2 >= len || (s[i + 1] & 0xC0) != 0x80 || (s[i + 2] & 0xC0) != 0x80) return false;
            if (s[i] == 0xE0 && s[i + 1] < 0xA0) return false;   // Overlong
            if (s[i] == 0xED && s[i + 1] >= 0xA0) return false;  // Surrogate halves
            i += 3;
        } else if ((s[i] & 0xF8) == 0xF0) {
            if (s[i] > 0xF4) return false;  // Code points above U+10FFFF are invalid in UTF-8
            if (i + 3 >= len || (s[i + 1] & 0xC0) != 0x80 || (s[i + 2] & 0xC0) != 0x80 || (s[i + 3] & 0xC0) != 0x80)
                return false;
            if (s[i] == 0xF0 && s[i + 1] < 0x90) return false;   // Overlong
            if (s[i] == 0xF4 && s[i + 1] >= 0x90) return false;  // Out of Unicode range (> 0x10FFFF)
            i += 4;
        } else {
            return false;
        }
    }
    return true;
}

std::optional<bool> compare_int_double_equal(int64_t i, double d) noexcept {
    if (std::isnan(d)) {
        return std::nullopt;  // UNKNOWN in 3VL
    }
    if (!std::isfinite(d)) {
        return false;
    }

    constexpr double kMinInt64 = -9223372036854775808.0;     // -2^63
    constexpr double kPastMaxInt64 = 9223372036854775808.0;  // 2^63

    if (d < kMinInt64 || d >= kPastMaxInt64) {
        return false;
    }

    double integral_part;
    if (std::modf(d, &integral_part) != 0.0) {
        return false;
    }

    // Now safe to convert integral_part to int64_t
    return i == static_cast<int64_t>(integral_part);
}

std::optional<bool> compare_int_double_less_than(int64_t i, double d) noexcept {
    if (std::isnan(d)) {
        return std::nullopt;  // UNKNOWN in 3VL
    }
    if (std::isinf(d)) {
        return d > 0.0;  // i < +inf is true, i < -inf is false
    }

    constexpr double kMinInt64 = -9223372036854775808.0;     // -2^63
    constexpr double kPastMaxInt64 = 9223372036854775808.0;  // 2^63

    if (d >= kPastMaxInt64) {
        return true;  // i < d is always true since i <= 2^63 - 1 < d
    }

    if (d <= kMinInt64) {
        return false;  // i < d is always false since i >= -2^63 >= d
    }

    double int_part;
    const double frac = std::modf(d, &int_part);
    const auto d_int = static_cast<int64_t>(int_part);

    if (frac == 0.0) {
        return i < d_int;
    }

    // d has fractional part: i < d is equivalent to i <= floor(d)
    const double floor_d = std::floor(d);
    return i <= static_cast<int64_t>(floor_d);
}

std::optional<bool> Value::compare_equals(const Value& other) const noexcept {
    if (is_null() || other.is_null()) {
        return std::nullopt;  // NULL = anything is UNKNOWN
    }

    // A DOUBLE NaN compared with any value returns UNKNOWN in SQL 3VL
    if ((type_ == TypeId::DOUBLE && std::isnan(as_double())) ||
        (other.type_ == TypeId::DOUBLE && std::isnan(other.as_double()))) {
        return std::nullopt;
    }

    if (type_ == TypeId::INT && other.type_ == TypeId::INT) {
        return as_int() == other.as_int();
    }

    if (type_ == TypeId::DOUBLE && other.type_ == TypeId::DOUBLE) {
        return as_double() == other.as_double();
    }

    if (type_ == TypeId::TEXT && other.type_ == TypeId::TEXT) {
        return as_text() == other.as_text();  // exact bytewise
    }

    if (type_ == TypeId::INT && other.type_ == TypeId::DOUBLE) {
        return compare_int_double_equal(as_int(), other.as_double());
    }

    if (type_ == TypeId::DOUBLE && other.type_ == TypeId::INT) {
        return compare_int_double_equal(other.as_int(), as_double());
    }

    return false;  // Cross-type comparison (e.g. TEXT vs INT)
}

std::optional<bool> Value::compare_less_than(const Value& other) const noexcept {
    if (is_null() || other.is_null()) {
        return std::nullopt;
    }

    // A DOUBLE NaN compared with any value returns UNKNOWN in SQL 3VL
    if ((type_ == TypeId::DOUBLE && std::isnan(as_double())) ||
        (other.type_ == TypeId::DOUBLE && std::isnan(other.as_double()))) {
        return std::nullopt;
    }

    if (type_ == TypeId::INT && other.type_ == TypeId::INT) {
        return as_int() < other.as_int();
    }
    if (type_ == TypeId::DOUBLE && other.type_ == TypeId::DOUBLE) {
        return as_double() < other.as_double();
    }
    if (type_ == TypeId::TEXT && other.type_ == TypeId::TEXT) {
        return as_text() < other.as_text();  // exact bytewise
    }
    if (type_ == TypeId::INT && other.type_ == TypeId::DOUBLE) {
        return compare_int_double_less_than(as_int(), other.as_double());
    }
    if (type_ == TypeId::DOUBLE && other.type_ == TypeId::INT) {
        // d < i is equivalent to: NOT (i <= d)
        // Check equality first:
        auto eq = compare_int_double_equal(other.as_int(), as_double());
        if (!eq.has_value()) return std::nullopt;
        if (*eq) return false;  // d == i, so d < i is false
        // Since not equal: d < i <=> NOT (other.as_int() < as_double())
        auto lt = compare_int_double_less_than(other.as_int(), as_double());
        if (!lt.has_value()) return std::nullopt;
        return !(*lt);
    }

    return false;
}

}  // namespace webdb
