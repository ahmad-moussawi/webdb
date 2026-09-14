#pragma once

#include "common/types.hpp"

#include <string>
#include <variant>
#include <optional>
#include <cmath>

namespace webdb {

class Value {
public:
    Value() noexcept : type_(TypeId::INVALID), is_null_(true), data_(std::monostate{}) {}

    static Value make_null(TypeId type) noexcept {
        Value v;
        v.type_ = type;
        v.is_null_ = true;
        v.data_ = std::monostate{};
        return v;
    }

    static Value make_int(int64_t val) noexcept {
        Value v;
        v.type_ = TypeId::INT;
        v.is_null_ = false;
        v.data_ = val;
        return v;
    }

    static Value make_double(double val) noexcept {
        Value v;
        v.type_ = TypeId::DOUBLE;
        v.is_null_ = false;
        v.data_ = val;
        return v;
    }

    static Value make_text(std::string str) noexcept {
        Value v;
        v.type_ = TypeId::TEXT;
        v.is_null_ = false;
        v.data_ = std::move(str);
        return v;
    }

    bool is_null() const noexcept { return is_null_; }
    TypeId type() const noexcept { return type_; }

    int64_t as_int() const { return std::get<int64_t>(data_); }
    double as_double() const { return std::get<double>(data_); }
    const std::string& as_text() const { return std::get<std::string>(data_); }

    // SQL Three-Valued Logic comparisons (returns true, false, or std::nullopt for UNKNOWN)
    std::optional<bool> compare_equals(const Value& other) const noexcept;
    std::optional<bool> compare_less_than(const Value& other) const noexcept;

    // Helper for UTF-8 byte validation
    static bool is_valid_utf8(std::string_view sv) noexcept;

private:
    TypeId type_{TypeId::INVALID};
    bool is_null_{true};
    std::variant<std::monostate, int64_t, double, std::string> data_{std::monostate{}};
};

// Exact comparison functions between INT and DOUBLE
std::optional<bool> compare_int_double_equal(int64_t i, double d) noexcept;
std::optional<bool> compare_int_double_less_than(int64_t i, double d) noexcept;

} // namespace webdb
